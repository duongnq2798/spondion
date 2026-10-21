import type { Operation } from './types.ts';

export type SqlValue = string | number | null;
export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface SqlDatabase { prepare(query: string): SqlStatement }

/** Additive migration: retain this table when reverting a Worker deployment. */
export const OPERATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS merchant_operations (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  query TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('sandbox', 'live')),
  phase TEXT NOT NULL CHECK (phase IN ('authorizing', 'executing', 'settling', 'succeeded', 'failed', 'unknown')),
  unit_price_atomic TEXT NOT NULL,
  amount_atomic TEXT NOT NULL DEFAULT '0',
  result_json TEXT,
  transaction_id TEXT,
  error_code TEXT,
  authorization_id TEXT UNIQUE,
  authorization_json TEXT,
  claim_token TEXT NOT NULL,
  phase_expires_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS merchant_operations_owner_history
  ON merchant_operations (owner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS merchant_operations_owner_expiry
  ON merchant_operations (owner_id, phase_expires_at)
  WHERE phase IN ('authorizing', 'executing', 'settling');
`;

export type OperationPhase = 'authorizing' | 'executing' | 'settling' | 'succeeded' | 'failed' | 'unknown';
export interface OperationRow {
  id: string;
  owner_id: string;
  idempotency_key: string;
  query: string;
  mode: Operation['mode'];
  phase: OperationPhase;
  unit_price_atomic: string;
  amount_atomic: string;
  result_json: string | null;
  transaction_id: string | null;
  error_code: string | null;
  authorization_id: string | null;
  authorization_json: string | null;
  claim_token: string;
  phase_expires_at: number | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, owner_id, idempotency_key, query, mode, phase, unit_price_atomic,
  amount_atomic, result_json, transaction_id, error_code, authorization_id,
  authorization_json, claim_token, phase_expires_at, created_at, updated_at`;

export function createOperationStore(db: SqlDatabase) {
  return {
    async expire(ownerId: string, timestamp: string, nowMs: number) {
      await db.prepare(`UPDATE merchant_operations SET
        error_code = CASE WHEN phase = 'settling' THEN 'PAYMENT_OUTCOME_UNKNOWN' ELSE 'OPERATION_INTERRUPTED' END,
        phase = 'unknown', phase_expires_at = NULL, updated_at = ?
        WHERE owner_id = ? AND phase IN ('authorizing', 'executing', 'settling') AND phase_expires_at <= ?`)
        .bind(timestamp, ownerId, nowMs).run();
    },
    async claim(row: OperationRow) {
      return db.prepare(`INSERT INTO merchant_operations
        (id, owner_id, idempotency_key, query, mode, phase, unit_price_atomic, amount_atomic,
        claim_token, phase_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, ?)
        ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING ${COLUMNS}`)
        .bind(row.id, row.owner_id, row.idempotency_key, row.query, row.mode, row.phase,
          row.unit_price_atomic, row.claim_token, row.phase_expires_at, row.created_at, row.updated_at)
        .first<OperationRow>();
    },
    async findByKey(ownerId: string, key: string) {
      return db.prepare(`SELECT ${COLUMNS} FROM merchant_operations WHERE owner_id = ? AND idempotency_key = ? LIMIT 1`)
        .bind(ownerId, key).first<OperationRow>();
    },
    async get(ownerId: string, id: string) {
      return db.prepare(`SELECT ${COLUMNS} FROM merchant_operations WHERE owner_id = ? AND id = ? LIMIT 1`)
        .bind(ownerId, id).first<OperationRow>();
    },
    async list(ownerId: string) {
      const { results } = await db.prepare(`SELECT ${COLUMNS} FROM merchant_operations
        WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`).bind(ownerId).all<OperationRow>();
      return results;
    },
    async authorize(row: OperationRow, authorizationId: string, authorizationJson: string, timestamp: string, nowMs: number, expiresAt: number) {
      // The global UNIQUE authorization_id prevents spending one proof on another logical operation.
      return db.prepare(`UPDATE merchant_operations SET authorization_id = ?, authorization_json = ?,
        phase = 'executing', phase_expires_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND claim_token = ? AND phase = 'authorizing' AND phase_expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM merchant_operations WHERE authorization_id = ?)
        RETURNING ${COLUMNS}`)
        .bind(authorizationId, authorizationJson, expiresAt, timestamp, row.id, row.owner_id, row.claim_token, nowMs, authorizationId)
        .first<OperationRow>();
    },
    async completeSearch(row: OperationRow, resultJson: string, timestamp: string, nowMs: number, expiresAt: number) {
      const next = row.mode === 'live' ? 'settling' : 'succeeded';
      return db.prepare(`UPDATE merchant_operations SET result_json = ?, phase = ?,
        phase_expires_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND claim_token = ?
        AND phase = 'executing' AND phase_expires_at > ? RETURNING ${COLUMNS}`)
        .bind(resultJson, next, next === 'settling' ? expiresAt : null, timestamp,
          row.id, row.owner_id, row.claim_token, nowMs).first<OperationRow>();
    },
    async completeSettlement(row: OperationRow, transaction: string, timestamp: string, nowMs: number) {
      return db.prepare(`UPDATE merchant_operations SET phase = 'succeeded', amount_atomic = unit_price_atomic,
        transaction_id = ?, phase_expires_at = NULL, updated_at = ?
        WHERE id = ? AND owner_id = ? AND claim_token = ? AND phase = 'settling' AND phase_expires_at > ?
        RETURNING ${COLUMNS}`)
        .bind(transaction, timestamp, row.id, row.owner_id, row.claim_token, nowMs).first<OperationRow>();
    },
    async fail(row: OperationRow, phase: 'failed' | 'unknown', errorCode: string, timestamp: string, nowMs: number) {
      return db.prepare(`UPDATE merchant_operations SET phase = ?, error_code = ?, phase_expires_at = NULL, updated_at = ?
        WHERE id = ? AND owner_id = ? AND claim_token = ? AND phase = ? AND phase_expires_at > ?
        RETURNING ${COLUMNS}`)
        .bind(phase, errorCode, timestamp, row.id, row.owner_id, row.claim_token, row.phase, nowMs).first<OperationRow>();
    },
  };
}
