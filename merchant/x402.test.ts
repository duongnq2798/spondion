import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createX402PaymentAdapter, createX402SettlementHeader } from './x402.ts';

const recipient = '0x2222222222222222222222222222222222222222';
const payer = '0x1111111111111111111111111111111111111111';
const network = 'eip155:8453' as const;
const resourceUrl = 'https://merchant.example/v1/search';
const config = { liveEnabled: true, recipient, facilitatorUrl: 'https://facilitator.example', resourceUrl, priceAtomic: '1000' };
const context = { operationId: 'op-1', ownerId: 'provider-1', query: 'payment channels', amountAtomic: '1000', unitPriceAtomic: '1000', units: 1 as const };
const requirement = { scheme: 'exact', network, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000', payTo: recipient, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' } };
function payment(overrides: Record<string, unknown> = {}) {
  return { x402Version: 2, resource: { url: resourceUrl, description: 'One search request', mimeType: 'application/json' }, accepted: requirement, payload: { signature: `0x${'11'.repeat(65)}`, authorization: { from: payer, to: recipient, value: '1000', validAfter: '0', validBefore: '9999999999', nonce: `0x${'ab'.repeat(32)}` } }, ...overrides };
}
function facilitator(settle?: () => Response | Promise<Response>) {
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push({ path, body: request.method === 'POST' ? await request.json() as Record<string, unknown> : undefined });
    if (path === '/supported') return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network }], extensions: [], signers: { [network]: [payer] } });
    if (path === '/verify') return Response.json({ isValid: true, payer });
    if (path === '/settle') return settle ? settle() : Response.json({ success: true, transaction: `0x${'cd'.repeat(32)}`, network, payer });
    throw new Error(`Unexpected external request ${path}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('live adapter fails closed before facilitator access when configuration is absent', async () => {
  const boundary = facilitator();
  try {
    for (const missing of [{ liveEnabled: false }, { recipient: '' }, { facilitatorUrl: '' }]) {
      assert.throws(() => createX402PaymentAdapter({ ...config, ...missing }), /config|disabled|recipient|facilitator/i);
    }
    assert.equal(boundary.calls.length, 0);
  } finally { boundary.restore(); }
});

test('official v2 challenge and signature encoding round trip into exact USDC verification and settlement', async () => {
  const boundary = facilitator();
  try {
    const adapter = createX402PaymentAdapter(config);
    const challenge = await adapter.requirements();
    const decoded = decodePaymentRequiredHeader(challenge.header);
    assert.equal(decoded.x402Version, 2);
    assert.equal(decoded.resource.url, resourceUrl);
    assert.equal(decoded.accepts[0].amount, '1000');
    assert.equal(decoded.accepts[0].network, network);
    assert.equal(decoded.accepts[0].payTo.toLowerCase(), recipient);
    const authorization = await adapter.verify(encodePaymentSignatureHeader(payment()), context);
    assert.equal(authorization.authorizationId, `${network}:${payer}:0x${'ab'.repeat(32)}`);
    const settled = await adapter.settle(authorization, context);
    assert.equal(settled.transaction, `0x${'cd'.repeat(32)}`);
    assert.deepEqual(decodePaymentResponseHeader(createX402SettlementHeader(settled.transaction)), { success: true, transaction: `0x${'cd'.repeat(32)}`, network });
    assert.deepEqual(boundary.calls.map(call => call.path), ['/supported', '/verify', '/settle']);
    assert.equal((boundary.calls[1].body?.paymentRequirements as Record<string, unknown>).amount, '1000');
  } finally { boundary.restore(); }
});

test('caller mutation of a verified payload cannot replace the authorization submitted for settlement', async () => {
  const boundary = facilitator();
  try {
    const adapter = createX402PaymentAdapter(config);
    const verified = await adapter.verify(payment(), context);
    const exposed = verified.payload as { payment: { payload: { authorization: { to: string } } } };
    exposed.payment.payload.authorization.to = payer;
    await adapter.settle(verified, context);
    const sent = boundary.calls.find(call => call.path === '/settle')!.body!.paymentPayload as { payload: { authorization: { to: string } } };
    assert.equal(sent.payload.authorization.to, recipient);
    verified.authorizationId = 'caller-replaced-identity';
    await assert.rejects(adapter.settle(verified, context), /attempted|reconcil|identity/i);
    assert.equal(boundary.calls.filter(call => call.path === '/settle').length, 1);
  } finally { boundary.restore(); }
});

test('facilitator authentication uses endpoint-scoped SDK headers and pending settlement submits once', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(new URL(request.url).pathname);
    assert.equal(request.headers.get('Authorization'), 'Bearer facilitator-secret');
    if (request.url.endsWith('/supported')) return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network }], extensions: [], signers: { [network]: [payer] } });
    if (request.url.endsWith('/verify')) return Response.json({ isValid: true, payer });
    return Response.json({ success: false, errorReason: 'settlement_pending', transaction: `0x${'ef'.repeat(32)}`, network, payer });
  };
  try {
    const adapter = createX402PaymentAdapter({ ...config, createAuthHeaders: async () => ({ supported: { Authorization: 'Bearer facilitator-secret' }, verify: { Authorization: 'Bearer facilitator-secret' }, settle: { Authorization: 'Bearer facilitator-secret' } }) });
    const verified = await adapter.verify(payment(), context);
    await assert.rejects(adapter.settle(verified, context), /unresolved|reconcil/i);
    assert.deepEqual(seen, ['/supported', '/verify', '/settle']);
  } finally { globalThis.fetch = original; }
});

test('same USDC nonce has the same authorization identity despite signature bytes changing', async () => {
  const boundary = facilitator();
  try {
    const adapter = createX402PaymentAdapter(config);
    const first = await adapter.verify(payment(), context);
    const other = payment();
    other.payload.signature = `0x${'22'.repeat(65)}`;
    const second = await adapter.verify(other, context);
    assert.equal(first.authorizationId, second.authorizationId);
  } finally { boundary.restore(); }
});

test('underpayment, altered recipient, unsupported permit and wrong operation amount fail before verify', async () => {
  const boundary = facilitator();
  try {
    const adapter = createX402PaymentAdapter(config);
    await assert.rejects(adapter.verify(payment({ accepted: { ...requirement, amount: '999' } }), context), /requirements|amount|payment/i);
    const changedRecipient = payment(); changedRecipient.payload.authorization.to = payer;
    await assert.rejects(adapter.verify(changedRecipient, context), /recipient|authorization|payment/i);
    await assert.rejects(adapter.verify(payment({ payload: { permit2Authorization: {} } }), context), /authorization|supported|payment/i);
    await assert.rejects(adapter.verify(payment(), { ...context, amountAtomic: '999' }), /amount|price/i);
    assert.equal(boundary.calls.filter(call => call.path === '/verify').length, 0);
  } finally { boundary.restore(); }
});

test('settlement is bound to verified operation and is never automatically repeated after a timeout', async () => {
  const boundary = facilitator(() => { throw new TypeError('connection lost after submission'); });
  try {
    const adapter = createX402PaymentAdapter(config);
    const verified = await adapter.verify(payment(), context);
    await assert.rejects(adapter.settle(verified, { ...context, operationId: 'different' }), /operation|context/i);
    await assert.rejects(adapter.settle(verified, context), /connection lost/);
    await assert.rejects(adapter.settle(verified, context), /reconcil|attempted|unknown/i);
    assert.equal(boundary.calls.filter(call => call.path === '/settle').length, 1);
  } finally { boundary.restore(); }
});

test('verified authorization survives the core durable JSON boundary without trusting caller fields', async () => {
  const boundary = facilitator();
  try {
    const adapter = createX402PaymentAdapter(config);
    const verified = await adapter.verify(payment(), context);
    const persisted = JSON.parse(JSON.stringify(verified));
    assert.equal((await adapter.settle(persisted, context)).transaction, `0x${'cd'.repeat(32)}`);
  } finally { boundary.restore(); }
});
