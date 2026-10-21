import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem';
import { createOperationService, OperationError } from './core.ts';
import { createReconciliationService, readBaseSettlement, type SettlementSnapshot } from './reconcile.ts';
import { OPERATION_SCHEMA_SQL } from './store.ts';
import { sqliteDatabase } from './testing/sqlite.ts';
import { X402_NETWORK, X402_USDC } from './x402.ts';

const owner = 'merchant:primary';
const payer = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const nonce = `0x${'44'.repeat(32)}` as const;
const hash = `0x${'55'.repeat(32)}` as const;
const blockHash = `0x${'66'.repeat(32)}` as const;
const events = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);

function authorization() {
  return { authorizationId: `${X402_NETWORK}:${payer}:${nonce}`, payload: {
    verificationToken: crypto.randomUUID(), payment: { x402Version: 2,
      resource: { url: 'https://spondion.example/v1/search' },
      accepted: { scheme: 'exact', network: X402_NETWORK, asset: X402_USDC, amount: '1000', payTo: recipient, maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'eip3009' } },
      payload: { signature: `0x${'77'.repeat(65)}`, authorization: { from: payer, to: recipient, value: '1000', validAfter: '1', validBefore: '1999999999', nonce } },
    },
  } };
}
function snapshot(): SettlementSnapshot {
  return { chainId: 8453, finalizedBlockNumber: 100n, canonicalBlockHash: blockHash, receipt: {
    status: 'success', transactionHash: hash, blockHash, blockNumber: 90n,
    logs: [
      { address: X402_USDC, topics: encodeEventTopics({ abi: events, eventName: 'AuthorizationUsed', args: { authorizer: payer, nonce } }) as Hex[], data: '0x', logIndex: 3, transactionHash: hash, blockHash, removed: false },
      { address: X402_USDC, topics: encodeEventTopics({ abi: events, eventName: 'Transfer', args: { from: payer, to: recipient } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [1000n]), logIndex: 4, transactionHash: hash, blockHash, removed: false },
    ],
  } };
}
async function fixture() {
  const database = sqliteDatabase(); database.sqlite.exec(OPERATION_SCHEMA_SQL);
  let searches = 0, settlements = 0;
  const service = createOperationService({ db: database.db, mode: 'live', unitPriceAtomic: '1000',
    search: async () => { searches++; return [{ title: 'Saved answer', url: 'https://example.com', snippet: 'Original result' }]; },
    payment: { verify: async () => authorization(), settle: async () => { settlements++; throw new Error('Timeout after submission'); } },
  });
  const operation = await service.run(owner, 'reconcile-logical-key', 'refund', 'proof');
  assert.equal(operation.status, 'unknown'); assert.equal(operation.result, null);
  return { ...database, service, operation, counts: () => ({ searches, settlements }) };
}
const rejected = (code: string) => (error: unknown) => error instanceof OperationError && error.code === code;

test('finalized exact authorization + transfer atomically restores original result and a private-safe audit; replay does not pay again', async () => {
  const f = await fixture(); let reads = 0;
  try {
    const reconciler = createReconciliationService({ db: f.db, verifier: async () => { reads++; return snapshot(); }, now: () => new Date('2026-10-21T04:00:00Z') });
    const receipt = await reconciler.reconcile(owner, f.operation.id, hash);
    assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.amountAtomic, '1000');
    assert.equal(receipt.result?.results[0].title, 'Saved answer');
    assert.equal(receipt.transaction, hash);
    assert.equal(receipt.reconciliation?.blockNumber, '90');
    assert.equal(receipt.reconciliation?.nonce, nonce);
    assert.equal(receipt.reconciliation?.checkedAt, '2026-10-21T04:00:00.000Z');
    assert.equal(JSON.stringify(receipt).includes('signature'), false);
    assert.deepEqual(await reconciler.reconcile(owner, f.operation.id, hash.toUpperCase().replace('0X', '0x')), receipt);
    assert.equal(reads, 1); assert.deepEqual(f.counts(), { searches: 1, settlements: 1 });
    assert.deepEqual(await f.service.get(owner, receipt.id), receipt);
    await assert.rejects(reconciler.reconcile(owner, receipt.id, `0x${'88'.repeat(32)}`), rejected('RECONCILIATION_CONFLICT'));
  } finally { f.close(); }
});

const invalid: [string, (s: SettlementSnapshot) => void][] = [
  ['wrong chain', s => { s.chainId = 1; }],
  ['reverted receipt', s => { s.receipt.status = 'reverted'; }],
  ['wrong transaction hash', s => { s.receipt.transactionHash = `0x${'00'.repeat(32)}`; }],
  ['unfinalized receipt', s => { s.finalizedBlockNumber = 89n; }],
  ['noncanonical receipt block', s => { s.canonicalBlockHash = `0x${'99'.repeat(32)}`; }],
  ['wrong token', s => { s.receipt.logs[0].address = other; s.receipt.logs[1].address = other; }],
  ['wrong nonce', s => { s.receipt.logs[0].topics[2] = `0x${'99'.repeat(32)}`; }],
  ['wrong payer', s => { s.receipt.logs[1].topics = encodeEventTopics({ abi: events, eventName: 'Transfer', args: { from: other, to: recipient } }) as Hex[]; }],
  ['wrong recipient', s => { s.receipt.logs[1].topics = encodeEventTopics({ abi: events, eventName: 'Transfer', args: { from: payer, to: other } }) as Hex[]; }],
  ['wrong amount', s => { s.receipt.logs[1].data = encodeAbiParameters([{ type: 'uint256' }], [1001n]); }],
  ['removed log', s => { s.receipt.logs[0].removed = true; }],
  ['unpaired unrelated transfer', s => { s.receipt.logs[1].logIndex = 5; }],
  ['duplicate authorization', s => { s.receipt.logs.push({ ...s.receipt.logs[0], logIndex: 9 }); }],
];
for (const [label, mutate] of invalid) test(`reconciliation rejects ${label} and keeps zero confirmed charge`, async () => {
  const f = await fixture();
  try {
    const value = snapshot(); mutate(value);
    const reconciler = createReconciliationService({ db: f.db, verifier: async () => value });
    await assert.rejects(reconciler.reconcile(owner, f.operation.id, hash), error => error instanceof OperationError);
    const current = await f.service.get(owner, f.operation.id);
    assert.equal(current?.status, 'unknown'); assert.equal(current?.amountAtomic, '0'); assert.equal(current?.result, null);
    assert.deepEqual(f.counts(), { searches: 1, settlements: 1 });
  } finally { f.close(); }
});

test('RPC timeout, unknown operation and cross-owner access fail without a state change or privacy leak', async () => {
  const f = await fixture(); let reads = 0;
  try {
    const reconciler = createReconciliationService({ db: f.db, verifier: async () => { reads++; throw new Error('RPC timeout'); } });
    await assert.rejects(reconciler.reconcile('another-owner', f.operation.id, hash), rejected('NOT_FOUND'));
    assert.equal(reads, 0);
    await assert.rejects(reconciler.reconcile(owner, f.operation.id, 'invalid'), rejected('INVALID_TRANSACTION_HASH'));
    assert.equal(reads, 0);
    await assert.rejects(reconciler.reconcile(owner, f.operation.id, hash), rejected('RECONCILIATION_UNAVAILABLE'));
    assert.equal((await f.service.get(owner, f.operation.id))?.status, 'unknown');
  } finally { f.close(); }
});

test('missing saved result and corrupted payment snapshot cannot be reconciled', async () => {
  const f = await fixture(); let reads = 0;
  try {
    const reconciler = createReconciliationService({ db: f.db, verifier: async () => { reads++; return snapshot(); } });
    f.sqlite.prepare('UPDATE merchant_operations SET result_json = NULL WHERE id = ?').run(f.operation.id);
    await assert.rejects(reconciler.reconcile(owner, f.operation.id, hash), rejected('RECONCILIATION_NOT_ELIGIBLE'));
    f.sqlite.prepare('UPDATE merchant_operations SET result_json = ?, authorization_json = ? WHERE id = ?').run('{"results":[]}', '{}', f.operation.id);
    await assert.rejects(reconciler.reconcile(owner, f.operation.id, hash), rejected('RECONCILIATION_NOT_ELIGIBLE'));
    assert.equal(reads, 0);
  } finally { f.close(); }
});

test('concurrent reconciliation claims converge on one persisted proof and one confirmed charge', async () => {
  const f = await fixture();
  try {
    const reconciler = createReconciliationService({ db: f.db, verifier: async () => snapshot() });
    const results = await Promise.all(Array.from({ length: 8 }, () => reconciler.reconcile(owner, f.operation.id, hash)));
    assert.ok(results.every(value => value.status === 'succeeded' && value.amountAtomic === '1000'));
    assert.equal(new Set(results.map(value => JSON.stringify(value.reconciliation))).size, 1);
    assert.deepEqual(f.counts(), { searches: 1, settlements: 1 });
  } finally { f.close(); }
});

test('production verifier uses only the pinned Base RPC read methods, finalized state and canonical block lookup', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { method: string; params: unknown[] }[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://mainnet.base.org/');
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      calls.push({ method: request.method, params: request.params });
      let result: unknown;
      if (request.method === 'eth_chainId') result = '0x2105';
      else if (request.method === 'eth_getTransactionReceipt') {
        assert.deepEqual(request.params, [hash]);
        const receipt = snapshot().receipt;
        result = { ...receipt, status: '0x1', blockNumber: '0x5a', transactionIndex: '0x0', logs: receipt.logs.map(log => ({ ...log, logIndex: `0x${log.logIndex!.toString(16)}`, blockNumber: '0x5a', transactionIndex: '0x0' })) };
      } else if (request.method === 'eth_getBlockByNumber') {
        assert.ok(request.params[0] === 'finalized' || request.params[0] === '0x5a');
        result = { number: request.params[0] === 'finalized' ? '0x64' : '0x5a', hash: blockHash, transactions: [] };
      } else throw new Error(`Unexpected RPC method ${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
    };
    const result = await readBaseSettlement(hash);
    assert.equal(result.chainId, 8453); assert.equal(result.receipt.status, 'success');
    assert.equal(result.receipt.blockNumber, 90n); assert.equal(result.finalizedBlockNumber, 100n);
    assert.equal(result.canonicalBlockHash, blockHash);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map(call => call.method).sort(), ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber', 'eth_getTransactionReceipt']);
  } finally { globalThis.fetch = originalFetch; }
});
