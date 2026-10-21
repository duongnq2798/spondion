import { createOperationService, OperationError } from '../merchant/core.ts';
import type { SqlDatabase } from '../merchant/store.ts';
import type { Operation } from '../merchant/types.ts';
import { createX402PaymentAdapter, createX402SettlementHeader } from '../merchant/x402.ts';
import { createProviderProfileService } from '../merchant/provider.ts';
import { createReconciliationService } from '../merchant/reconcile.ts';
import { CORPUS_LABEL, createProviderSearch, readBoundedBody, searchDocumentation } from './search.ts';

export interface MerchantEnv {
  DB: SqlDatabase;
  SPONDION_LIVE_ENABLED?: string;
  SPONDION_MERCHANT_API_KEY?: string;
  SPONDION_PAY_TO?: string;
  SPONDION_PRICE_ATOMIC?: string;
  SPONDION_RESOURCE_URL?: string;
  SPONDION_FACILITATOR_URL?: string;
  SPONDION_FACILITATOR_AUTH_HEADER?: string;
  SPONDION_UPSTREAM_SEARCH_URL?: string;
  SPONDION_UPSTREAM_API_KEY?: string;
}

const SIGN_IN = '/signin-with-chatgpt?return_to=%2F';
function json(body: unknown, status = 200, headers?: HeadersInit) {
  const output = new Headers(headers);
  output.set('Content-Type', 'application/json; charset=utf-8');
  output.set('Cache-Control', 'private, no-store');
  output.set('X-Content-Type-Options', 'nosniff');
  output.set('Referrer-Policy', 'same-origin');
  return new Response(JSON.stringify(body), { status, headers: output });
}
function fail(code: string, message: string, status: number) { return json({ error: { code, message } }, status); }

function liveConfigured(env: MerchantEnv) {
  return env.SPONDION_LIVE_ENABLED === 'true' && [env.SPONDION_MERCHANT_API_KEY, env.SPONDION_PAY_TO, env.SPONDION_PRICE_ATOMIC, env.SPONDION_RESOURCE_URL, env.SPONDION_FACILITATOR_URL, env.SPONDION_UPSTREAM_SEARCH_URL, env.SPONDION_UPSTREAM_API_KEY].every(v => typeof v === 'string' && v.trim());
}

function name(request: Request) {
  const raw = request.headers.get('oai-authenticated-user-full-name');
  if (!raw) return 'Developer';
  try { return (request.headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8' ? decodeURIComponent(raw) : raw).slice(0, 100); }
  catch { return 'Developer'; }
}

async function apiKeyMatches(request: Request, expected: string) {
  const provided = request.headers.get('Authorization') ?? '';
  if (provided.length > 1024 || !provided.startsWith('Bearer ')) return false;
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(provided.slice(7)), digest(expected)]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let different = 0;
  for (let i = 0; i < aa.length; i++) different |= aa[i] ^ bb[i];
  return different === 0;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new OperationError('UNSUPPORTED_MEDIA_TYPE', 415, 'Send application/json.');
  let value: unknown;
  try { value = JSON.parse(await readBoundedBody(request, 8192)); }
  catch (error) {
    if (error instanceof RangeError) throw new OperationError('BODY_TOO_LARGE', 413, 'Request body exceeds 8 KB.');
    throw new OperationError('INVALID_JSON', 400, 'Send a valid JSON request.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OperationError('INVALID_REQUEST', 400, 'Send a query and idempotencyKey.');
  return value as Record<string, unknown>;
}

async function body(request: Request): Promise<{ query: string; idempotencyKey: string }> {
  const input = await readJson(request);
  const key = input.idempotencyKey ?? request.headers.get('Idempotency-Key');
  if (typeof input.query !== 'string' || typeof key !== 'string') throw new OperationError('INVALID_REQUEST', 400, 'Send a query and idempotencyKey.');
  if (request.headers.has('Idempotency-Key') && request.headers.get('Idempotency-Key') !== key) throw new OperationError('IDEMPOTENCY_CONFLICT', 409, 'Body and header request keys must match.');
  return { query: input.query, idempotencyKey: key };
}

async function admitSandbox(db: SqlDatabase, ownerId: string) {
  const day = new Date().toISOString().slice(0, 10);
  const admitted = await db.prepare(`INSERT INTO merchant_sandbox_limits (owner_id, day, count) VALUES (?, ?, 1)
    ON CONFLICT(owner_id,day) DO UPDATE SET count = count + 1 WHERE count < 100 RETURNING count`).bind(ownerId, day).first();
  if (!admitted) throw new OperationError('SANDBOX_LIMIT', 429, 'Sandbox daily limit reached. Saved requests remain available. Try again tomorrow.');
}

function operationResponse(operation: Operation, replayed: boolean, paid: boolean) {
  const headers: Record<string, string> = {};
  if (paid && operation.status === 'succeeded' && operation.transaction) headers['PAYMENT-RESPONSE'] = createX402SettlementHeader(operation.transaction);
  if (operation.status === 'pending') headers['Retry-After'] = '2';
  const status = operation.status === 'pending' ? 202 : operation.status === 'unknown' ? 503 : operation.status === 'failed' ? 422 : 200;
  const error = operation.status === 'unknown'
    ? { code: operation.error === 'PAYMENT_OUTCOME_UNKNOWN' ? 'settlement_unknown' : 'operation_unknown', message: 'The original operation needs reconciliation. No new payment or work will be attempted for this key.' }
    : operation.status === 'failed' ? { code: operation.error?.toLowerCase() ?? 'operation_failed', message: 'The operation failed. No confirmed customer charge is recorded.' } : undefined;
  return json({ operation, replayed, ...(error ? { error } : {}) }, status, headers);
}

export async function handleApi(request: Request, env: MerchantEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    const sandbox = url.pathname.startsWith('/api/merchant/');
    const paid = url.pathname.startsWith('/v1/');
    if (!sandbox && !paid) return fail('NOT_FOUND', 'API route not found.', 404);
    if (request.method !== 'GET' && request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'Use GET or POST.', 405);
    if (request.method === 'POST' && (request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin))) return fail('CROSS_ORIGIN_REQUEST', 'Use this API from its own origin.', 403);
    const identity = request.headers.get('oai-authenticated-user-id');
    if (sandbox && url.pathname === '/api/merchant/me' && request.method === 'GET') return json({ authenticated: Boolean(identity), user: identity ? { name: name(request) } : null, mode: 'sandbox', liveConfigured: liveConfigured(env), signInUrl: SIGN_IN, corpusLabel: CORPUS_LABEL });
    if (!env.DB) return fail('DATABASE_UNAVAILABLE', 'Workspace storage is not available.', 503);
    if (sandbox && !identity) return fail('AUTHENTICATION_REQUIRED', 'Sign in with ChatGPT to save and view your sandbox operations.', 401);
    // Recorded receipts and reconciliation remain available during a payment shutdown.
    if (paid && !env.SPONDION_MERCHANT_API_KEY) return fail('LIVE_NOT_CONFIGURED', 'Live payments are not configured. Use the no-payment sandbox.', 503);
    if (paid && !await apiKeyMatches(request, env.SPONDION_MERCHANT_API_KEY!)) return fail('AUTHENTICATION_REQUIRED', 'A merchant API credential is required.', 401);

    const ownerId = sandbox ? `site:${identity!}` : 'merchant:primary';
    const base = sandbox ? '/api/merchant' : '/v1';
    if (sandbox && url.pathname === base + '/provider') {
      const profiles = createProviderProfileService(env.DB);
      return json({ profile: request.method === 'POST' ? await profiles.save(ownerId, await readJson(request)) : await profiles.get(ownerId) });
    }
    const reconciliationMatch = paid && /^\/v1\/operations\/([^/]+)\/reconcile$/.exec(url.pathname);
    if (request.method === 'POST' && reconciliationMatch) {
      const input = await readJson(request);
      if (Object.keys(input).length !== 1 || typeof input.transaction !== 'string') return fail('INVALID_REQUEST', 'Send only the transaction hash to inspect.', 400);
      const operation = await createReconciliationService({ db: env.DB }).reconcile(ownerId, reconciliationMatch[1], input.transaction);
      return operationResponse(operation, true, true);
    }
    const reader = createOperationService({ db: env.DB, search: searchDocumentation });
    if (request.method === 'GET' && url.pathname === base + '/operations') {
      const key = url.searchParams.get('key');
      if (key) {
        const operation = await reader.findByKey(ownerId, key);
        return operation ? json({ operation }) : fail('NOT_FOUND', 'Operation not found.', 404);
      }
      return json({ operations: await reader.list(ownerId) });
    }
    if (request.method === 'GET' && url.pathname.startsWith(base + '/operations/')) {
      const id = url.pathname.slice((base + '/operations/').length);
      const operation = await reader.get(ownerId, id);
      return operation ? json({ operation }) : fail('NOT_FOUND', 'Operation not found.', 404);
    }
    if (request.method === 'POST' && url.pathname === base + '/search') {
      if (paid && !liveConfigured(env)) return fail('LIVE_NOT_CONFIGURED', 'Live payments are not configured. Use the no-payment sandbox.', 503);
      if (paid && env.SPONDION_RESOURCE_URL !== `${url.origin}/v1/search`) return fail('INVALID_CONFIGURATION', 'Configured payment resource does not match this deployment.', 503);
      const payment = paid ? createX402PaymentAdapter({ liveEnabled: true, recipient: env.SPONDION_PAY_TO!, priceAtomic: env.SPONDION_PRICE_ATOMIC!, resourceUrl: env.SPONDION_RESOURCE_URL!, facilitatorUrl: env.SPONDION_FACILITATOR_URL!, ...(env.SPONDION_FACILITATOR_AUTH_HEADER ? { createAuthHeaders: async () => ({ verify: { Authorization: env.SPONDION_FACILITATOR_AUTH_HEADER! }, settle: { Authorization: env.SPONDION_FACILITATOR_AUTH_HEADER! }, supported: { Authorization: env.SPONDION_FACILITATOR_AUTH_HEADER! } }) } : {}) }) : undefined;
      const service = paid ? createOperationService({ db: env.DB, mode: 'live', unitPriceAtomic: env.SPONDION_PRICE_ATOMIC, payment, search: createProviderSearch(env.SPONDION_UPSTREAM_SEARCH_URL!, env.SPONDION_UPSTREAM_API_KEY!) }) : reader;
      const input = await body(request);
      const previous = await service.findByKey(ownerId, input.idempotencyKey);
      if (sandbox && !previous) await admitSandbox(env.DB, ownerId);
      const signature = request.headers.get('PAYMENT-SIGNATURE');
      if (paid && !signature && !previous) {
        const challenge = await payment!.requirements();
        return json(challenge.body, 402, { 'PAYMENT-REQUIRED': challenge.header });
      }
      const operation = await service.run(ownerId, input.idempotencyKey, input.query, signature ?? undefined);
      return operationResponse(operation, Boolean(previous), paid);
    }
    return fail('NOT_FOUND', 'API route not found.', 404);
  } catch (error) {
    if (error instanceof OperationError) return fail(error.code, error.message, error.status);
    return fail('SERVICE_UNAVAILABLE', 'The workspace could not complete this request. Retry the same request key to inspect its recorded state.', 503);
  }
}
