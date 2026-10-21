import assert from 'node:assert/strict';
import { test } from 'node:test';
import { x402Client } from '@x402/core/client';
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { createMerchantClient, createX402MerchantClient, type MerchantAttempt, type MerchantAttemptStore } from './client.ts';
import { sqliteDatabase } from '../merchant/testing/sqlite.ts';
import { OPERATION_SCHEMA_SQL } from '../merchant/store.ts';
import { handleApi, type MerchantEnv } from '../worker/api.ts';

const recipient = '0x2222222222222222222222222222222222222222';
const requirement = { scheme: 'exact', network: 'eip155:8453' as const, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000', payTo: recipient, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' } };
const challenge = { x402Version: 2, resource: { url: 'https://merchant.example/v1/search', description: 'One search request', mimeType: 'application/json' }, accepts: [requirement] };
function fakePaymentClient() {
  let signatures = 0;
  const client = new x402Client().setSpendControls(false).register('eip155:8453', {
    scheme: 'exact',
    async createPaymentPayload() { signatures++; return { x402Version: 2, payload: { signature: '0xfake-no-wallet-signature', authorization: { nonce: '0xoriginal-nonce' } } }; },
  });
  return { client, count: () => signatures };
}

test('HTTP retry reuses the exact payment header, request key and body after an ambiguous transport failure', async () => {
  const signer = fakePaymentClient();
  const seen: Request[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(request.clone());
    if (!request.headers.has('PAYMENT-SIGNATURE')) return Response.json(challenge, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge) } });
    if (seen.length === 2) throw new TypeError('response lost');
    return Response.json({ operation: { state: 'completed', id: 'op-1' } });
  };
  const client = createMerchantClient({ baseUrl: 'https://merchant.example', apiKey: 'provider-secret', fetch: fakeFetch, paymentClient: signer.client });
  await assert.rejects(client.search('payment channels', { idempotencyKey: 'merchant-request-01' }), /response lost/);
  assert.equal(seen.length, 2);
  const response = await client.retry('merchant-request-01');
  assert.equal(response.status, 200);
  assert.equal(signer.count(), 1);
  assert.equal(seen[1].headers.get('PAYMENT-SIGNATURE'), seen[2].headers.get('PAYMENT-SIGNATURE'));
  assert.equal(decodePaymentSignatureHeader(seen[2].headers.get('PAYMENT-SIGNATURE')!).payload.authorization && true, true);
  for (const request of seen) {
    assert.equal(request.headers.get('Idempotency-Key'), 'merchant-request-01');
    assert.equal(request.headers.get('Authorization'), 'Bearer provider-secret');
    assert.deepEqual(await request.json(), { query: 'payment channels', idempotencyKey: 'merchant-request-01' });
  }
});

test('settlement unknown requires reconciliation and never retries or generates a second authorization', async () => {
  const signer = fakePaymentClient(); let sends = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    sends++;
    const request = new Request(input, init);
    if (!request.headers.has('PAYMENT-SIGNATURE')) return Response.json(challenge, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge) } });
    return Response.json({ operation: { state: 'settlement_unknown', id: 'op-unknown' } }, { status: 409 });
  };
  const client = createMerchantClient({ baseUrl: 'https://merchant.example', fetch: fakeFetch, paymentClient: signer.client });
  assert.equal((await client.search('search', { idempotencyKey: 'merchant-request-02' })).status, 409);
  await assert.rejects(client.retry('merchant-request-02'), /reconcil/i);
  assert.equal(sends, 2);
  assert.equal(signer.count(), 1);
});

test('same key with changed payload is rejected locally and duplicate calls share one in-flight execution', async () => {
  let sends = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = createMerchantClient({ baseUrl: 'https://merchant.example', fetch: async () => { sends++; await gate; return Response.json({ operation: { state: 'completed' } }); } });
  const first = client.search('first', { idempotencyKey: 'merchant-request-03' });
  const duplicate = client.search('first', { idempotencyKey: 'merchant-request-03' });
  await assert.rejects(client.search('changed', { idempotencyKey: 'merchant-request-03' }), /different|conflict|payload/i);
  release();
  assert.equal((await first).status, 200); assert.equal((await duplicate).status, 200);
  assert.equal(sends, 1);
});

test('caller can retrieve original operation without a payment and cannot retry an untracked key', async () => {
  const seen: Request[] = [];
  const client = createMerchantClient({ baseUrl: 'https://merchant.example', apiKey: 'secret', fetch: async (input, init) => { seen.push(new Request(input, init)); return Response.json({ operation: { state: 'settlement_unknown' } }); } });
  await client.findByKey('original-request-key-0001');
  assert.equal(seen[0].url, 'https://merchant.example/v1/operations?key=original-request-key-0001');
  assert.equal(seen[0].method, 'GET'); assert.equal(seen[0].headers.has('PAYMENT-SIGNATURE'), false);
  await assert.rejects(client.retry('untracked-request-key-0001'), /reconcil|unknown|tracked/i);
  assert.equal(seen.length, 1);
});

test('real exact client refuses a challenge outside the pinned USDC amount before caller signing', async () => {
  let signatures = 0;
  const client = createX402MerchantClient({ baseUrl: 'https://merchant.example', recipient, maxAmountAtomic: '1000', signer: { address: '0x1111111111111111111111111111111111111111', signTypedData: async () => { signatures++; throw new Error('must not sign'); } }, fetch: async () => Response.json({ ...challenge, accepts: [{ ...requirement, amount: '1001' }] }, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ ...challenge, accepts: [{ ...requirement, amount: '1001' }] }) } }) });
  await assert.rejects(client.search('query', { idempotencyKey: 'over-budget-request-0001' }), /policy|amount|acceptable|requirements|payment/i);
  assert.equal(signatures, 0);
});

test('saved authorization survives caller restart and is reused without a new signature', async () => {
  const values = new Map<string, MerchantAttempt>();
  const store: MerchantAttemptStore = { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, structuredClone(value)); } };
  const signing = fakePaymentClient();
  const seen: string[] = [];
  let loseResponse = true;
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const header = request.headers.get('PAYMENT-SIGNATURE');
    if (!header) return Response.json(challenge, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge) } });
    seen.push(header);
    if (loseResponse) { loseResponse = false; throw new Error('lost after submission'); }
    return Response.json({ operation: { status: 'succeeded' }, replayed: true });
  };
  const first = createMerchantClient({ baseUrl: 'https://merchant.example', fetch: fakeFetch, paymentClient: signing.client, attemptStore: store });
  await assert.rejects(first.search('saved query', { idempotencyKey: 'durable-client-key-0001' }), /lost/);
  assert.equal(values.get('durable-client-key-0001')!.state, 'sent');
  const restarted = createMerchantClient({ baseUrl: 'https://merchant.example', fetch: fakeFetch, paymentClient: signing.client, attemptStore: store });
  assert.equal((await restarted.retry('durable-client-key-0001')).status, 200);
  assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]); assert.equal(signing.count(), 1);
});

test('real exact EOA factory creates the maintained v2 payment shape without a wallet or network', async () => {
  let signatures = 0; let sends = 0;
  let sentPayment: ReturnType<typeof decodePaymentSignatureHeader> | undefined;
  const client = createX402MerchantClient({ baseUrl: 'https://merchant.example', recipient, maxAmountAtomic: '1000', signer: {
    address: '0x1111111111111111111111111111111111111111',
    async signTypedData() { signatures++; return `0x${'11'.repeat(65)}`; },
  }, fetch: async (input, init) => {
    sends++;
    const request = new Request(input, init); const signature = request.headers.get('PAYMENT-SIGNATURE');
    if (!signature) return Response.json(challenge, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge) } });
    sentPayment = decodePaymentSignatureHeader(signature);
    return Response.json({ operation: { status: 'succeeded' } });
  } });
  assert.equal((await client.search('exact profile', { idempotencyKey: 'exact-profile-request-0001' })).status, 200);
  assert.equal(signatures, 1); assert.equal(sends, 2);
  assert.equal(sentPayment!.x402Version, 2); assert.equal(sentPayment!.accepted.network, 'eip155:8453');
  const authorization = sentPayment!.payload.authorization as Record<string, unknown>;
  assert.equal(authorization.from, '0x1111111111111111111111111111111111111111');
  assert.equal(authorization.to, recipient); assert.equal(authorization.value, '1000');
  assert.match(String(authorization.nonce), /^0x[0-9a-f]{64}$/);
});

test('unreviewed extensions and excessive authorization lifetime are refused before caller signing', async () => {
  let signatures = 0;
  for (const unsafe of [
    { ...challenge, accepts: [{ ...requirement, maxTimeoutSeconds: 86400 }] },
    { ...challenge, extensions: { 'erc20ApprovalGasSponsoring': {} } },
  ]) {
    const client = createX402MerchantClient({ baseUrl: 'https://merchant.example', recipient, maxAmountAtomic: '1000', signer: { address: '0x1111111111111111111111111111111111111111', async signTypedData() { signatures++; throw new Error('unexpected signature'); } }, fetch: async () => Response.json(unsafe, { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(unsafe) } }) });
    await assert.rejects(client.search('query', { idempotencyKey: `unsafe-request-key-${signatures}` }), /payment|requirements|extension|lifetime/i);
  }
  assert.equal(signatures, 0);
});

test('provider unknown status blocks resend even when returned without a settlement header', async () => {
  let sends = 0;
  const client = createMerchantClient({ baseUrl: 'https://merchant.example', fetch: async () => { sends++; return Response.json({ operation: { status: 'unknown' }, error: { code: 'operation_unknown' } }, { status: 503 }); } });
  await client.search('query', { idempotencyKey: 'unknown-provider-key-0001' });
  await assert.rejects(client.retry('unknown-provider-key-0001'), /reconcil/i);
  assert.equal(sends, 1);
});

test('request keys outside the server 16–128 character contract fail before network or signing', async () => {
  let sends = 0;
  const signer = fakePaymentClient();
  const client = createMerchantClient({ baseUrl: 'https://merchant.example', paymentClient: signer.client, fetch: async () => { sends++; return Response.json({ operation: { status: 'succeeded' } }); } });
  for (const key of ['', 'short-key', 'a'.repeat(15), 'a'.repeat(129), '_invalid-first-character', 'invalid-request/key']) {
    await assert.rejects(client.search('query', { idempotencyKey: key }), /16|128|key/i);
    await assert.rejects(client.retry(key), /16|128|key/i);
    await assert.rejects(client.findByKey(key), /16|128|key/i);
  }
  assert.equal(sends, 0);
  assert.equal(signer.count(), 0);
});

/** Real SDK → Worker request/response → core → SQLite. Only the external HTTP services are fake. */
function integratedMerchant(options: { losePaidResponse?: boolean; unknownSettlement?: boolean } = {}) {
  const storage = sqliteDatabase();
  storage.sqlite.exec(OPERATION_SCHEMA_SQL);
  const counts = { signatures: 0, api: 0, verify: 0, settle: 0, upstream: 0 };
  const statuses: number[] = [];
  const originalFetch = globalThis.fetch;
  const env: MerchantEnv = {
    DB: storage.db,
    SPONDION_LIVE_ENABLED: 'true',
    SPONDION_MERCHANT_API_KEY: 'integration-provider-credential',
    SPONDION_PAY_TO: recipient,
    SPONDION_PRICE_ATOMIC: '1000',
    SPONDION_RESOURCE_URL: 'https://merchant.example/v1/search',
    SPONDION_FACILITATOR_URL: 'https://facilitator.example',
    SPONDION_FACILITATOR_AUTH_HEADER: 'Bearer facilitator-credential',
    SPONDION_UPSTREAM_SEARCH_URL: 'https://provider.example/search',
    SPONDION_UPSTREAM_API_KEY: 'upstream-credential',
  };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === 'https://facilitator.example') {
      assert.equal(request.headers.get('Authorization'), 'Bearer facilitator-credential');
      if (url.pathname === '/supported') return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [], signers: { 'eip155:8453': ['0x1111111111111111111111111111111111111111'] } });
      const body = await request.json() as { paymentRequirements: { amount: string }; paymentPayload: { payload: { authorization: { value: string } } } };
      assert.equal(body.paymentRequirements.amount, '1000');
      assert.equal(body.paymentPayload.payload.authorization.value, '1000');
      if (url.pathname === '/verify') { counts.verify++; return Response.json({ isValid: true, payer: '0x1111111111111111111111111111111111111111' }); }
      if (url.pathname === '/settle') {
        counts.settle++;
        if (options.unknownSettlement) throw new TypeError('facilitator response lost after submission');
        return Response.json({ success: true, transaction: `0x${'cd'.repeat(32)}`, network: 'eip155:8453', payer: '0x1111111111111111111111111111111111111111' });
      }
    }
    if (url.href === 'https://provider.example/search') {
      counts.upstream++;
      assert.equal(request.headers.get('Authorization'), 'Bearer upstream-credential');
      assert.equal((await request.json() as { query: string }).query, 'payment channels');
      return Response.json({ results: [{ title: 'Payment channels', url: 'https://source.example/channels', content: 'Provider result from the intercepted boundary' }] });
    }
    throw new Error(`Unexpected network boundary: ${request.method} ${request.url}`);
  };
  let lost = false;
  const apiFetch: typeof fetch = async (input, init) => {
    counts.api++;
    const request = new Request(input, init);
    const hasPayment = request.headers.has('PAYMENT-SIGNATURE');
    const response = await handleApi(request, env);
    statuses.push(response.status);
    if (options.losePaidResponse && hasPayment && !lost) { lost = true; throw new TypeError('merchant response lost after completion'); }
    return response;
  };
  const client = () => createX402MerchantClient({
    baseUrl: 'https://merchant.example', apiKey: env.SPONDION_MERCHANT_API_KEY,
    recipient, maxAmountAtomic: '1000', fetch: apiFetch,
    signer: { address: '0x1111111111111111111111111111111111111111', async signTypedData() { counts.signatures++; return `0x${'11'.repeat(65)}`; } },
  });
  return { ...storage, env, counts, statuses, client, close() { globalThis.fetch = originalFetch; storage.close(); } };
}

test('SDK and actual paid Worker recover a completed SQLite operation after response loss without another payment', async () => {
  const integrated = integratedMerchant({ losePaidResponse: true });
  try {
    const client = integrated.client();
    const key = 'a'.repeat(16);
    await assert.rejects(client.search('payment channels', { idempotencyKey: key }), /response lost after completion/);
    const replay = await client.retry(key);
    assert.equal(replay.status, 200);
    const payload = await replay.json();
    assert.equal(payload.operation.status, 'succeeded');
    assert.equal(payload.operation.amountAtomic, '1000');
    assert.equal(payload.operation.idempotencyKey, key);
    assert.equal(payload.replayed, true);
    assert.equal(payload.operation.result.results[0].snippet, 'Provider result from the intercepted boundary');
    assert.equal(decodePaymentResponseHeader(replay.headers.get('PAYMENT-RESPONSE')!).transaction, payload.operation.transaction);
    const found = await (await integrated.client().findByKey(key)).json();
    assert.equal(found.operation.id, payload.operation.id);
    const receipt = await (await client.getOperation(payload.operation.id)).json();
    assert.equal(receipt.operation.amountAtomic, '1000');
    const changed = await integrated.client().search('different query', { idempotencyKey: key });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(integrated.statuses.slice(0, 3), [402, 200, 200]);
    assert.equal(integrated.counts.signatures, 1);
    assert.equal(integrated.counts.verify, 1);
    assert.equal(integrated.counts.settle, 1);
    assert.equal(integrated.counts.upstream, 1);
    assert.equal(integrated.sqlite.prepare('SELECT count(*) AS n FROM merchant_operations').get()!.n, 1);
  } finally { integrated.close(); }
});

test('SDK and actual paid Worker preserve unknown503 state in SQLite and never reauthorize or settle on restart', async () => {
  const integrated = integratedMerchant({ unknownSettlement: true });
  try {
    const client = integrated.client();
    const key = 'b'.repeat(128);
    const response = await client.search('payment channels', { idempotencyKey: key });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.operation.status, 'unknown');
    assert.equal(body.operation.amountAtomic, '0');
    assert.equal(body.operation.transaction, null);
    assert.equal(body.error.code, 'settlement_unknown');
    await assert.rejects(client.retry(key), /reconcil/i);
    const restarted = integrated.client();
    assert.equal((await restarted.findByKey(key)).status, 200);
    assert.equal((await restarted.search('payment channels', { idempotencyKey: key })).status, 503);
    assert.equal(integrated.counts.signatures, 1);
    assert.equal(integrated.counts.verify, 1);
    assert.equal(integrated.counts.settle, 1);
    assert.equal(integrated.counts.upstream, 1);
    assert.equal(integrated.sqlite.prepare('SELECT phase FROM merchant_operations').get()!.phase, 'unknown');
  } finally { integrated.close(); }
});
