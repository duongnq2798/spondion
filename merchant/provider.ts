import { OperationError } from './core.ts';
import type { SqlDatabase } from './store.ts';

/** Non-secret onboarding metadata. Saving a draft never enables live payments. */
export interface ProviderDraft {
  displayName: string;
  searchEndpoint: string;
  payoutAddress: string;
  priceAtomic: string;
}

export interface ProviderProfile extends ProviderDraft { updatedAt: string }

/** Test schema; production uses the versioned additive D1 migration. */
export const PROFILE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS merchant_provider_profiles (
  owner_id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  search_endpoint TEXT NOT NULL,
  payout_address TEXT NOT NULL,
  price_atomic TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

interface ProfileRow {
  display_name: string;
  search_endpoint: string;
  payout_address: string;
  price_atomic: string;
  updated_at: string;
}

const FIELDS = new Set(['displayName', 'searchEndpoint', 'payoutAddress', 'priceAtomic']);
const MAX_PRICE_ATOMIC = 100_000_000n; // 100 USDC per basic search, six decimals.
const COLUMNS = 'display_name, search_endpoint, payout_address, price_atomic, updated_at';

function invalid(message: string): never {
  throw new OperationError('INVALID_PROVIDER_PROFILE', 400, message);
}

function assertOwner(ownerId: string) {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200) {
    throw new OperationError('AUTHENTICATION_REQUIRED', 401, 'Sign in to access your provider draft.');
  }
}

function endpoint(value: string) {
  if (!value) return '';
  if (value.length > 500 || /\s/.test(value)) invalid('Use a public HTTPS search endpoint of at most 500 characters, without credentials, query parameters or fragments.');
  let url: URL;
  try { url = new URL(value); } catch { return invalid('Enter a valid HTTPS search endpoint.'); }
  const host = url.hostname;
  const labels = host.split('.');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    value.includes('?') || value.includes('#') || (url.port && url.port !== '443') ||
    labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    /^\d+(?:\.\d+){3}$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|example|invalid|home|lan|onion)$/.test(host)) {
    invalid('Use a public HTTPS search endpoint without credentials, query parameters or fragments.');
  }
  return url.href;
}

function normalize(input: unknown): ProviderDraft {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Send a provider draft.');
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some(key => !FIELDS.has(key))) invalid('Save only provider name, endpoint, payout address and atomic price. Never enter API keys or secrets here.');
  for (const field of FIELDS) if (typeof fields[field] !== 'string') invalid('Provider draft fields must be text.');
  const displayName = (fields.displayName as string).trim();
  const searchEndpoint = (fields.searchEndpoint as string).trim();
  const payoutAddress = (fields.payoutAddress as string).trim();
  const priceAtomic = (fields.priceAtomic as string).trim();
  if (displayName.length < 2 || displayName.length > 80 || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(displayName)) invalid('Use a plain provider name of 2–80 characters.');
  if (payoutAddress && (!/^0x[0-9a-fA-F]{40}$/.test(payoutAddress) || /^0x0{40}$/i.test(payoutAddress))) invalid('Use a nonzero EVM payout address.');
  if (priceAtomic && (!/^[1-9]\d{0,8}$/.test(priceAtomic) || BigInt(priceAtomic) > MAX_PRICE_ATOMIC)) invalid('Use an exact positive atomic price up to 100000000 (100 USDC), or leave it blank.');
  return { displayName, searchEndpoint: endpoint(searchEndpoint), payoutAddress, priceAtomic };
}

function profile(row: ProfileRow): ProviderProfile {
  return { displayName: row.display_name, searchEndpoint: row.search_endpoint, payoutAddress: row.payout_address, priceAtomic: row.price_atomic, updatedAt: row.updated_at };
}

export function createProviderProfileService(db: SqlDatabase, now: () => Date = () => new Date()) {
  return {
    async get(ownerId: string): Promise<ProviderProfile | null> {
      assertOwner(ownerId);
      const row = await db.prepare(`SELECT ${COLUMNS} FROM merchant_provider_profiles WHERE owner_id = ? LIMIT 1`)
        .bind(ownerId).first<ProfileRow>();
      return row ? profile(row) : null;
    },
    async save(ownerId: string, input: unknown): Promise<ProviderProfile> {
      assertOwner(ownerId);
      const draft = normalize(input);
      const row = await db.prepare(`INSERT INTO merchant_provider_profiles (owner_id, ${COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET
        display_name = excluded.display_name, search_endpoint = excluded.search_endpoint,
        payout_address = excluded.payout_address, price_atomic = excluded.price_atomic,
        updated_at = excluded.updated_at RETURNING ${COLUMNS}`)
        .bind(ownerId, draft.displayName, draft.searchEndpoint, draft.payoutAddress, draft.priceAtomic, now().toISOString())
        .first<ProfileRow>();
      if (!row) throw new Error('Provider draft could not be saved.');
      return profile(row);
    },
  };
}
