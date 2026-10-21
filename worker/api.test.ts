import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sqliteDatabase } from '../merchant/testing/sqlite.ts';
import { handleApi } from './api.ts';
import { searchDocumentation, createProviderSearch, readBoundedBody } from './search.ts';

function setup() {
  const storage = sqliteDatabase();
  storage.sqlite.exec(readFileSync(new URL('../drizzle/0000_cool_king_cobra.sql', import.meta.url), 'utf8'));
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
