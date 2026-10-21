import { createOperationStore } from './store.ts';
import type { OperationRow, SqlDatabase } from './store.ts';
import type { Operation, PaymentAdapter, PaymentContext, SearchResult, VerifiedPayment } from './types.ts';

export class OperationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.status = status;
  }
}

/** Upstream may have executed; the same logical operation must never be attempted again. */
export class IndeterminateOperationError extends Error {}

export interface OperationServiceOptions {
  db: SqlDatabase;
  search(query: string): Promise<SearchResult[]>;
  mode?: Operation['mode'];
  unitPriceAtomic?: string;
  payment?: PaymentAdapter;
  now?: () => Date;
  phaseTimeoutMs?: number;
}

function assertOwner(ownerId: string) {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200) {
    throw new OperationError('AUTHENTICATION_REQUIRED', 401, 'Sign in to access merchant operations.');
  }
}

function assertKey(key: string) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) {
    throw new OperationError('INVALID_IDEMPOTENCY_KEY', 400, 'Use a 16–128 character idempotency key containing letters, digits, dot, underscore, colon or dash.');
  }
}

function normalizeQuery(query: string) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(query)) {
    throw new OperationError('INVALID_QUERY', 400, 'Enter a search query of 1–500 characters.');
  }
  return query.trim();
}

export function publicOperation(row: OperationRow): Operation {
  return {
    id: row.id, idempotencyKey: row.idempotency_key, query: row.query, mode: row.mode,
    status: ['authorizing', 'executing', 'settling'].includes(row.phase) ? 'pending' : row.phase as Operation['status'],
    amountAtomic: row.amount_atomic, unitPriceAtomic: row.unit_price_atomic, units: 1,
    transaction: row.transaction_id,
    ...(row.reconciliation_json ? { reconciliation: JSON.parse(row.reconciliation_json) as Operation['reconciliation'] } : {}),
    result: row.phase === 'succeeded' && row.result_json ? JSON.parse(row.result_json) as Operation['result'] : null,
    error: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function boundedResults(value: SearchResult[]): { results: SearchResult[] } {
  if (!Array.isArray(value)) throw new Error('Invalid provider result.');
  const results = value.slice(0, 5).map(item => {
    if (!item || typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.snippet !== 'string') {
      throw new Error('Invalid provider result.');
    }
    if (!item.title.trim() || item.title.length > 200 || item.url.length > 2048 || item.snippet.length > 1000) {
      throw new Error('Provider result exceeds limits.');
    }
    const url = new URL(item.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe provider URL.');
    return { title: item.title, url: item.url, snippet: item.snippet };
  });
  return { results };
}

function validatedAuthorization(value: VerifiedPayment) {
  if (!value || typeof value.authorizationId !== 'string' || !value.authorizationId.trim() || value.authorizationId.length > 512) {
    throw new Error('Invalid payment authorization identity.');
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > 32768) throw new Error('Payment authorization exceeds limit.');
  return encoded;
}

export function createOperationService(options: OperationServiceOptions) {
  const mode = options.mode ?? 'sandbox';
  const price = mode === 'sandbox' ? '0' : options.unitPriceAtomic;
  const timeout = options.phaseTimeoutMs ?? 120_000;
  if (!['sandbox', 'live'].includes(mode) || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 900_000) {
    throw new OperationError('INVALID_CONFIGURATION', 503, 'Merchant operation configuration is invalid.');
  }
  if (mode === 'live' && (!options.payment || typeof price !== 'string' || !/^[1-9][0-9]{0,77}$/.test(price))) {
    throw new OperationError('LIVE_NOT_CONFIGURED', 503, 'Live payment service is not configured.');
  }
  const unitPriceAtomic = price as string;
  const store = createOperationStore(options.db);
  const clock = options.now ?? (() => new Date());
  const stamp = () => { const date = clock(); return { iso: date.toISOString(), ms: date.getTime() }; };

  async function expire(ownerId: string) {
    const time = stamp();
    await store.expire(ownerId, time.iso, time.ms);
  }

  async function get(ownerId: string, id: string): Promise<Operation | null> {
    assertOwner(ownerId);
    if (typeof id !== 'string' || id.length > 128) return null;
    await expire(ownerId);
    const row = await store.get(ownerId, id);
    return row ? publicOperation(row) : null;
  }

  async function findByKey(ownerId: string, key: string): Promise<Operation | null> {
    assertOwner(ownerId);
    assertKey(key);
    await expire(ownerId);
    const row = await store.findByKey(ownerId, key);
    return row ? publicOperation(row) : null;
  }

  async function readClaim(row: OperationRow): Promise<Operation> {
    const operation = await get(row.owner_id, row.id);
    if (!operation) throw new OperationError('OPERATION_UNAVAILABLE', 503, 'Operation state is unavailable.');
    return operation;
  }

  async function fail(row: OperationRow, phase: 'failed' | 'unknown', errorCode: string) {
    const time = stamp();
    const updated = await store.fail(row, phase, errorCode, time.iso, time.ms);
    return updated ? publicOperation(updated) : readClaim(row);
  }

  function context(row: OperationRow): PaymentContext {
    return { operationId: row.id, ownerId: row.owner_id, query: row.query, amountAtomic: row.unit_price_atomic, unitPriceAtomic: row.unit_price_atomic, units: 1 };
  }

  async function authorize(row: OperationRow, input: unknown): Promise<OperationRow | null> {
    let authorization: VerifiedPayment;
    let authorizationJson: string;
    try {
      authorization = await options.payment!.verify(input, context(row));
      authorizationJson = validatedAuthorization(authorization);
    } catch (error) {
      await fail(row, error instanceof IndeterminateOperationError ? 'unknown' : 'failed', 'PAYMENT_VERIFICATION_FAILED');
      return null;
    }
    const time = stamp();
    const updated = await store.authorize(row, authorization.authorizationId, authorizationJson, time.iso, time.ms, time.ms + timeout);
    if (!updated) await fail(row, 'failed', 'PAYMENT_AUTHORIZATION_REUSED');
    return updated;
  }

  async function execute(row: OperationRow): Promise<Operation> {
    let resultJson: string;
    try {
      resultJson = JSON.stringify(boundedResults(await options.search(row.query)));
    } catch (error) {
      return fail(row, error instanceof IndeterminateOperationError ? 'unknown' : 'failed',
        error instanceof IndeterminateOperationError ? 'SEARCH_OUTCOME_UNKNOWN' : 'SEARCH_FAILED');
    }
    const time = stamp();
    const updated = await store.completeSearch(row, resultJson, time.iso, time.ms, time.ms + timeout);
    if (!updated) return readClaim(row);
    if (updated.mode === 'sandbox') return publicOperation(updated);
    return settle(updated);
  }

  async function settle(row: OperationRow): Promise<Operation> {
    let transaction: string;
    try {
      const authorization = JSON.parse(row.authorization_json!) as VerifiedPayment;
      const receipt = await options.payment!.settle(authorization, context(row));
      transaction = receipt.transaction;
      if (typeof transaction !== 'string' || !transaction.trim() || transaction.length > 2048) throw new Error('Invalid settlement receipt.');
    } catch {
      return fail(row, 'unknown', 'PAYMENT_OUTCOME_UNKNOWN');
    }
    const time = stamp();
    const updated = await store.completeSettlement(row, transaction, time.iso, time.ms);
    return updated ? publicOperation(updated) : readClaim(row);
  }

  function replay(row: OperationRow, query: string): Operation {
    if (row.query !== query || row.mode !== mode) {
      throw new OperationError('IDEMPOTENCY_CONFLICT', 409, 'This idempotency key already belongs to another request.');
    }
    return publicOperation(row);
  }

  async function run(ownerId: string, key: string, rawQuery: string, paymentInput?: unknown): Promise<Operation> {
    assertOwner(ownerId);
    assertKey(key);
    const query = normalizeQuery(rawQuery);
    await expire(ownerId);
    const previous = await store.findByKey(ownerId, key);
    if (previous) return replay(previous, query);
    if (mode === 'live' && paymentInput === undefined) {
      throw new OperationError('PAYMENT_REQUIRED', 402, 'A verified payment authorization is required.');
    }
    const time = stamp();
    const row: OperationRow = {
      id: crypto.randomUUID(), owner_id: ownerId, idempotency_key: key, query, mode,
      phase: mode === 'live' ? 'authorizing' : 'executing', unit_price_atomic: unitPriceAtomic,
      amount_atomic: '0', result_json: null, transaction_id: null, error_code: null,
      authorization_id: null, authorization_json: null, reconciliation_json: null, claim_token: crypto.randomUUID(),
      phase_expires_at: time.ms + timeout, created_at: time.iso, updated_at: time.iso,
    };
    const claimed = await store.claim(row);
    if (!claimed) {
      const concurrent = await store.findByKey(ownerId, key);
      if (!concurrent) throw new OperationError('OPERATION_UNAVAILABLE', 503, 'Operation state is unavailable.');
      return replay(concurrent, query);
    }
    if (mode === 'sandbox') return execute(claimed);
    const authorized = await authorize(claimed, paymentInput);
    return authorized ? execute(authorized) : readClaim(claimed);
  }

  return {
    run, get, findByKey,
    async list(ownerId: string): Promise<Operation[]> {
      assertOwner(ownerId);
      await expire(ownerId);
      return (await store.list(ownerId)).map(publicOperation);
    },
  };
}
