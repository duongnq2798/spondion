import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, uniqueIndex, index, check, primaryKey } from 'drizzle-orm/sqlite-core';

export const operations = sqliteTable('merchant_operations', {
  id: text('id').primaryKey().notNull(),
  ownerId: text('owner_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  query: text('query').notNull(),
  mode: text('mode').notNull(),
  phase: text('phase').notNull(),
  unitPriceAtomic: text('unit_price_atomic').notNull(),
  amountAtomic: text('amount_atomic').notNull().default('0'),
  resultJson: text('result_json'),
  transactionId: text('transaction_id'),
  errorCode: text('error_code'),
  authorizationId: text('authorization_id'),
  authorizationJson: text('authorization_json'),
  reconciliationJson: text('reconciliation_json'),
  claimToken: text('claim_token').notNull(),
  phaseExpiresAt: integer('phase_expires_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, t => [
  uniqueIndex('merchant_operations_owner_key').on(t.ownerId, t.idempotencyKey),
  uniqueIndex('merchant_operations_authorization').on(t.authorizationId),
  index('merchant_operations_owner_history').on(t.ownerId, t.createdAt, t.id),
  index('merchant_operations_owner_expiry').on(t.ownerId, t.phaseExpiresAt).where(sql`${t.phase} IN ('authorizing','executing','settling')`),
  check('merchant_operations_mode_check', sql`${t.mode} IN ('sandbox','live')`),
  check('merchant_operations_phase_check', sql`${t.phase} IN ('authorizing','executing','settling','succeeded','failed','unknown')`),
]);

export const sandboxLimits = sqliteTable('merchant_sandbox_limits', {
  ownerId: text('owner_id').notNull(),
  day: text('day').notNull(),
  count: integer('count').notNull().default(1),
}, t => [primaryKey({ columns: [t.ownerId, t.day] })]);

/** Metadata drafts only. Runtime credentials and live activation stay server-owned. */
export const providerProfiles = sqliteTable('merchant_provider_profiles', {
  ownerId: text('owner_id').primaryKey().notNull(),
  displayName: text('display_name').notNull(),
  searchEndpoint: text('search_endpoint').notNull(),
  payoutAddress: text('payout_address').notNull(),
  priceAtomic: text('price_atomic').notNull(),
  updatedAt: text('updated_at').notNull(),
});
