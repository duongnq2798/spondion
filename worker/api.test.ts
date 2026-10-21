import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteDatabase } from '../merchant/testing/sqlite.ts';
import { handleApi } from './api.ts';
import { searchDocumentation, createProviderSearch, readBoundedBody } from './search.ts';

function setup() {
  const storage = sqliteDatabase();
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) {
    storage.sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  return { ...storage, env: { DB: storage.db } };
}
const origin = 'https://spondion.example';
function request(path: string, body?: unknown, owner = 'test-owner') {
  const headers = new Headers();
  if (owner) headers.set('oai-authenticated-user-id', owner);
  if (body !== undefined) { headers.set('Content-Type', 'application/json'); headers.set('Origin', origin); }
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('anonymous metadata offers sign in; anonymous writes never create operations', async () => {
  const s = setup();
  try {
    const me = await handleApi(request('/api/merchant/me', undefined, ''), s.env);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).authenticated, false);
    const result = await handleApi(request('/api/merchant/search', { query: 'refund', idempotencyKey: 'anonymous-key-0001' }, ''), s.env);
    assert.equal(result.status, 401);
    assert.equal(s.sqlite.prepare('SELECT count(*) AS n FROM merchant_operations').get()!.n, 0);
  } finally { s.close(); }
});

test('search, replay, reload history and receipt use the same durable operation', async () => {
  const s = setup();
  try {
    const body = { query: 'refund', idempotencyKey: 'durable-http-key-0001' };
    const first = await handleApi(request('/api/merchant/search', body), s.env);
    assert.equal(first.status, 200);
    const data = await first.json();
    assert.equal(data.operation.status, 'succeeded');
    assert.equal(data.operation.amountAtomic, '0');
    assert.equal(data.operation.transaction, null);
    assert.ok(data.operation.result.results.length > 0);
    const replay = await (await handleApi(request('/api/merchant/search', body), s.env)).json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.operation.id, data.operation.id);
    assert.deepEqual(replay.operation.result, data.operation.result);
    const history = await (await handleApi(request('/api/merchant/operations'), s.env)).json();
    assert.equal(history.operations.length, 1);
    const receipt = await handleApi(request('/api/merchant/operations/' + data.operation.id), s.env);
    assert.equal((await receipt.json()).operation.id, data.operation.id);
    assert.equal(receipt.headers.get('Cache-Control'), 'private, no-store');
    const other = await handleApi(request('/api/merchant/operations/' + data.operation.id, undefined, 'another-owner'), s.env);
    assert.equal(other.status, 404);
    const changed = await handleApi(request('/api/merchant/search', { ...body, query: 'other query' }), s.env);
    assert.equal(changed.status, 409);
  } finally { s.close(); }
});

test('sandbox rejects cross-origin writes, oversized data and wrong media type', async () => {
  const s = setup();
  try {
    const cross = request('/api/merchant/search', { query: 'refund', idempotencyKey: 'origin-check-key-01' });
    cross.headers.set('Origin', 'https://attacker.example');
    assert.equal((await handleApi(cross, s.env)).status, 403);
    const huge = request('/api/merchant/search', { query: 'r'.repeat(9000), idempotencyKey: 'oversize-key-0001' });
    assert.equal((await handleApi(huge, s.env)).status, 413);
    const media = request('/api/merchant/search', { query: 'refund', idempotencyKey: 'media-check-key-01' });
    media.headers.set('Content-Type', 'text/plain');
    assert.equal((await handleApi(media, s.env)).status, 415);
  } finally { s.close(); }
});

test('sandbox daily admission is bounded and paid routes fail closed', async () => {
  const s = setup();
  try {
    s.sqlite.prepare('INSERT INTO merchant_sandbox_limits VALUES(?,?,100)').run('site:test-owner', new Date().toISOString().slice(0,10));
    assert.equal((await handleApi(request('/api/merchant/search', { query: 'refund', idempotencyKey: 'budget-limit-key01' }), s.env)).status, 429);
    const paid = await handleApi(request('/v1/search', { query: 'refund', idempotencyKey: 'paid-unconfigured1' }), s.env);
    assert.equal(paid.status, 503);
    assert.equal(s.sqlite.prepare('SELECT count(*) AS n FROM merchant_operations').get()!.n, 0);
    assert.equal((await handleApi(request('/api/merchant/missing'), s.env)).status, 404);
  } finally { s.close(); }
});

test('documentation search executes a real bounded index query', async () => {
  const results = await searchDocumentation('refund USDC');
  assert.ok(results.length > 0 && results.length <= 5);
  assert.ok(results[0].snippet.toLowerCase().includes('refund'));
  assert.deepEqual(await searchDocumentation('zzznomatch99331'), []);
});

test('provider drafts persist per identity, reject secrets and cannot enable live payments', async () => {
  const s = setup();
  try {
    const draft = { displayName: 'Search pilot', searchEndpoint: 'https://provider.example.com/api/search', payoutAddress: '0x1111111111111111111111111111111111111111', priceAtomic: '2500' };
    assert.equal((await handleApi(request('/api/merchant/provider', undefined, ''), s.env)).status, 401);
    assert.equal((await (await handleApi(request('/api/merchant/provider'), s.env)).json()).profile, null);
    const saved = await handleApi(request('/api/merchant/provider', draft), s.env);
    assert.equal(saved.status, 200);
    const profile = (await saved.json()).profile;
    assert.equal(profile.priceAtomic, '2500');
    assert.deepEqual((await (await handleApi(request('/api/merchant/provider'), s.env)).json()).profile, profile);
    assert.equal((await (await handleApi(request('/api/merchant/provider', undefined, 'another-owner'), s.env)).json()).profile, null);
    const leaked = await handleApi(request('/api/merchant/provider', { ...draft, upstreamApiKey: 'do-not-store' }), s.env);
    assert.equal(leaked.status, 400);
    assert.equal((await (await handleApi(request('/api/merchant/provider'), s.env)).json()).profile.displayName, 'Search pilot');
    const cross = request('/api/merchant/provider', draft);
    cross.headers.set('Origin', 'https://attacker.example');
    assert.equal((await handleApi(cross, s.env)).status, 403);
    assert.equal((await (await handleApi(request('/api/merchant/me'), s.env)).json()).liveConfigured, false);
    assert.equal((await handleApi(request('/v1/search', { query: 'refund', idempotencyKey: 'profile-not-live1' }), s.env)).status, 503);
  } finally { s.close(); }
});

test('additive onboarding migration preserves an existing operation and receipt', async () => {
  const s = sqliteDatabase();
  try {
    s.sqlite.exec(readFileSync(new URL('../drizzle/0000_cool_king_cobra.sql', import.meta.url), 'utf8'));
    s.sqlite.prepare(`INSERT INTO merchant_operations
      (id, owner_id, idempotency_key, query, mode, phase, unit_price_atomic, result_json, claim_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'sandbox', 'succeeded', '0', ?, ?, ?, ?)`)
      .run('pre-upgrade-operation', 'site:test-owner', 'pre-upgrade-key-0001', 'refund', '{"results":[]}', 'original-claim', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z');
    s.sqlite.exec(readFileSync(new URL('../drizzle/0001_simple_joystick.sql', import.meta.url), 'utf8'));
    const result = await handleApi(request('/api/merchant/operations/pre-upgrade-operation'), { DB: s.db });
    assert.equal(result.status, 200);
    const receipt = (await result.json()).operation;
    assert.equal(receipt.idempotencyKey, 'pre-upgrade-key-0001');
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.amountAtomic, '0');
    assert.deepEqual(receipt.result, { results: [] });
    assert.equal(receipt.reconciliation, undefined);
    assert.equal(s.sqlite.prepare('SELECT reconciliation_json FROM merchant_operations').get()!.reconciliation_json, null);
    assert.equal(s.sqlite.prepare('SELECT count(*) AS n FROM merchant_provider_profiles').get()!.n, 0);
  } finally { s.close(); }
});

test('operator receipt reads and reconciliation stay authenticated while live charging is disabled', async () => {
  const s = setup();
  const env = { ...s.env, SPONDION_MERCHANT_API_KEY: 'operator-test-key' };
  function operator(path: string, input?: unknown) {
    const req = request(path, input);
    req.headers.set('Authorization', 'Bearer operator-test-key');
    return req;
  }
  try {
    assert.equal((await handleApi(request('/v1/operations'), env)).status, 401);
    assert.equal((await handleApi(operator('/v1/operations'), env)).status, 200);
    const missing = await handleApi(operator('/v1/operations/missing/reconcile', { transaction: '0x' + 'ab'.repeat(32) }), env);
    assert.equal(missing.status, 404);
    const invalid = await handleApi(operator('/v1/operations/missing/reconcile', { transaction: '0x' + 'ab'.repeat(32), rpcUrl: 'https://attacker.example' }), env);
    assert.equal(invalid.status, 400);
    assert.equal((await handleApi(request('/api/merchant/operations/missing/reconcile', { transaction: '0x' + 'ab'.repeat(32) }), env)).status, 404);
    assert.equal((await handleApi(operator('/v1/search', { query: 'refund', idempotencyKey: 'disabled-live-key1' }), env)).status, 503);
  } finally { s.close(); }
});

test('provider endpoint is configured, bounded, and never follows redirects', async () => {
  assert.throws(() => createProviderSearch('http://localhost/internal', 'key'));
  let received: RequestInit | undefined;
  const search = createProviderSearch('https://provider.example/search', 'private-key', async (_url, init) => {
    received = init;
    return Response.json({ results: [{ title: 'Real result', url: 'https://source.example/article', content: 'Search content' }] });
  });
  assert.equal((await search('refund'))[0].snippet, 'Search content');
  assert.equal(received?.redirect, 'error');
  assert.equal((received?.headers as Record<string,string>).Authorization, 'Bearer private-key');
  assert.equal(JSON.parse(String(received?.body)).max_results, 5);
  await assert.rejects(() => readBoundedBody(new Response('123456'), 5), RangeError);
});
