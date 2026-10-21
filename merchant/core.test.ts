import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOperationService, OperationError, IndeterminateOperationError } from './core.ts';
import { OPERATION_SCHEMA_SQL } from './store.ts';
import { sqliteDatabase } from './testing/sqlite.ts';
import type { PaymentAdapter, SearchResult } from './types.ts';

const key = 'request-0000000001';
const results: SearchResult[] = [{ title: 'Arc documentation', url: 'https://docs.arc.network/', snippet: 'An example corpus result.' }];

function database() {
  const instance = sqliteDatabase();
  instance.sqlite.exec(OPERATION_SCHEMA_SQL);
  return instance;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('sandbox persists a zero-charge result and exposes only its public receipt', async () => {
  const instance = database();
  try {
    const service = createOperationService({ db: instance.db, search: async () => results });
    const operation = await service.run('alice', key, 'Arc');
    assert.equal(operation.status, 'succeeded');
    assert.equal(operation.mode, 'sandbox');
    assert.equal(operation.amountAtomic, '0');
    assert.equal(operation.unitPriceAtomic, '0');
    assert.equal(operation.units, 1);
    assert.equal(operation.transaction, null);
    assert.deepEqual(operation.result, { results });
    assert.deepEqual(Object.keys(operation).sort(), ['id', 'idempotencyKey', 'query', 'mode', 'status', 'amountAtomic', 'unitPriceAtomic', 'units', 'transaction', 'result', 'error', 'createdAt', 'updatedAt'].sort());
    assert.deepEqual(await service.get('alice', operation.id), operation);
    assert.deepEqual(await service.findByKey('alice', key), operation);
  } finally { instance.close(); }
});

test('100 concurrent live duplicates execute and settle once through database claims', async () => {
  const instance = database();
  const searchGate = deferred<SearchResult[]>();
  let searches = 0;
  let verifications = 0;
  let settlements = 0;
  const payment: PaymentAdapter = {
    async verify(input, context) {
      verifications++;
      assert.equal(input, 'signed-authorization');
      assert.equal(context.amountAtomic, '900719925474099312345');
      assert.equal(context.units, 1);
      return { authorizationId: 'network:payer:nonce-1', payload: { signature: 'never-public' } };
    },
    async settle(authorization, context) {
      settlements++;
      assert.equal(authorization.authorizationId, 'network:payer:nonce-1');
      assert.equal(context.operationId.length > 0, true);
      return { transaction: '0xconfirmed' };
    },
  };
  const options = { db: instance.db, mode: 'live' as const, unitPriceAtomic: '900719925474099312345', payment, search: async () => { searches++; return searchGate.promise; } };
  try {
    // Two independent service objects: an in-memory promise cache cannot pass this test.
    const services = [createOperationService(options), createOperationService(options)];
    const calls = Array.from({ length: 100 }, (_, index) => services[index % 2].run('alice', key, 'Arc', 'signed-authorization'));
    searchGate.resolve(results);
    const operations = await Promise.all(calls);
    assert.equal(new Set(operations.map(operation => operation.id)).size, 1);
    const final = await services[1].run('alice', key, 'Arc');
    assert.equal(final.status, 'succeeded');
    assert.equal(final.transaction, '0xconfirmed');
    assert.equal(final.amountAtomic, '900719925474099312345');
    assert.equal(searches, 1);
    assert.equal(verifications, 1);
    assert.equal(settlements, 1);
    assert.equal(JSON.stringify(final).includes('never-public'), false);
  } finally { instance.close(); }
});

test('same key with another payload conflicts, while owners remain isolated', async () => {
  const instance = database();
  try {
    const service = createOperationService({ db: instance.db, search: async () => results });
    const alice = await service.run('alice', key, 'Arc');
    await assert.rejects(service.run('alice', key, 'USDC'), (error: unknown) => error instanceof OperationError && error.status === 409);
    assert.equal(await service.get('bob', alice.id), null);
    assert.equal(await service.findByKey('bob', key), null);
    assert.deepEqual(await service.list('bob'), []);
    const bob = await service.run('bob', key, 'USDC');
    assert.notEqual(alice.id, bob.id);
    assert.deepEqual((await service.list('alice')).map(operation => operation.id), [alice.id]);
  } finally { instance.close(); }
});

test('replaying a completed operation retains its original price after merchant pricing changes', async () => {
  const instance = database();
  let verifications = 0;
  let searches = 0;
  let settlements = 0;
  const payment: PaymentAdapter = {
    async verify(input) {
      verifications++;
      return { authorizationId: String(input), payload: {} };
    },
    async settle(_authorization, context) {
      settlements++;
      return { transaction: `tx-${context.amountAtomic}` };
    },
  };
  const service = (unitPriceAtomic: string) => createOperationService({
    db: instance.db, mode: 'live', unitPriceAtomic, payment,
    search: async () => { searches++; return results; },
  });
  try {
    const original = await service('1000').run('alice', key, 'Arc', 'original-price-proof');
    assert.equal(original.status, 'succeeded');
    assert.equal(original.unitPriceAtomic, '1000');
    assert.equal(original.amountAtomic, '1000');
    assert.equal(original.transaction, 'tx-1000');
    assert.deepEqual(original.result, { results });

    const repriced = service('2000');
    assert.deepEqual(await repriced.run('alice', key, 'Arc'), original);
    assert.equal(verifications, 1);
    assert.equal(searches, 1);
    assert.equal(settlements, 1);

    const next = await repriced.run('alice', 'request-0000000002', 'Arc', 'new-price-proof');
    assert.equal(next.status, 'succeeded');
    assert.equal(next.unitPriceAtomic, '2000');
    assert.equal(next.amountAtomic, '2000');
    assert.equal(next.transaction, 'tx-2000');
    assert.equal(verifications, 2);
    assert.equal(searches, 2);
    assert.equal(settlements, 2);
  } finally { instance.close(); }
});

test('disk-backed results survive closing SQLite and recreating the service', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spondion-operations-'));
  const path = join(directory, 'operations.sqlite');
  let instance = sqliteDatabase(path);
  try {
    instance.sqlite.exec(OPERATION_SCHEMA_SQL);
    const original = await createOperationService({ db: instance.db, search: async () => results }).run('alice', key, 'Arc');
    instance.close();
    instance = sqliteDatabase(path);
    const reopened = createOperationService({ db: instance.db, search: async () => { throw new Error('must not reexecute'); } });
    assert.deepEqual(await reopened.run('alice', key, 'Arc'), original);
    assert.deepEqual(await reopened.get('alice', original.id), original);
  } finally { instance.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('search failure is persisted without settlement or leaking upstream secrets', async () => {
  const instance = database();
  let settles = 0;
  let searches = 0;
  try {
    const service = createOperationService({
      db: instance.db, mode: 'live', unitPriceAtomic: '1000',
      search: async () => { searches++; throw new Error('secret-provider-token'); },
      payment: { verify: async () => ({ authorizationId: 'proof-failure', payload: {} }), settle: async () => { settles++; return { transaction: 'never' }; } },
    });
    const operation = await service.run('alice', key, 'Arc', {});
    assert.equal(operation.status, 'failed');
    assert.equal(operation.amountAtomic, '0');
    assert.equal(operation.transaction, null);
    assert.equal(JSON.stringify(operation).includes('secret-provider-token'), false);
    assert.deepEqual(await service.run('alice', key, 'Arc'), operation);
    assert.equal(searches, 1);
    assert.equal(settles, 0);
  } finally { instance.close(); }
});

test('a payment authorization cannot fund two logical operations, even across owners', async () => {
  const instance = database();
  let settles = 0;
  let searches = 0;
  try {
    const service = createOperationService({
      db: instance.db, mode: 'live', unitPriceAtomic: '1000',
      search: async () => { searches++; return results; },
      payment: { verify: async () => ({ authorizationId: 'network:payer:shared-nonce', payload: {} }), settle: async () => { settles++; return { transaction: 'tx-original' }; } },
    });
    assert.equal((await service.run('alice', key, 'Arc', {})).status, 'succeeded');
    const reused = await service.run('bob', 'request-0000000002', 'USDC', {});
    assert.equal(reused.status, 'failed');
    assert.equal(reused.amountAtomic, '0');
    assert.equal(searches, 1);
    assert.equal(settles, 1);
  } finally { instance.close(); }
});

test('ambiguous settlement preserves result and never settles again on retry or restart', async () => {
  const instance = database();
  let settles = 0;
  let searches = 0;
  const options = {
    db: instance.db, mode: 'live' as const, unitPriceAtomic: '1000', search: async () => { searches++; return results; },
    payment: { verify: async () => ({ authorizationId: 'proof-timeout', payload: {} }), settle: async () => { settles++; throw new Error('network timeout after submission'); } },
  };
  try {
    const operation = await createOperationService(options).run('alice', key, 'Arc', {});
    assert.equal(operation.status, 'unknown');
    assert.equal(operation.result, null);
    const stored = instance.sqlite.prepare('SELECT result_json FROM merchant_operations WHERE id = ?').get(operation.id);
    assert.deepEqual(JSON.parse(String(stored?.result_json)), { results });
    assert.equal(operation.amountAtomic, '0');
    assert.equal(operation.transaction, null);
    const replayed = await createOperationService(options).run('alice', key, 'Arc', {});
    assert.deepEqual(replayed, operation);
    assert.equal(settles, 1);
    assert.equal(searches, 1);
  } finally { instance.close(); }
});

test('expired upstream claim becomes unknown and a late result cannot trigger payment', async () => {
  const instance = database();
  const gate = deferred<SearchResult[]>();
  const started = deferred<void>();
  let now = new Date('2026-10-21T00:00:00Z');
  let searches = 0;
  let settles = 0;
  const options = {
    db: instance.db, mode: 'live' as const, unitPriceAtomic: '1000', now: () => now, phaseTimeoutMs: 1000,
    search: async () => { searches++; started.resolve(); return gate.promise; },
    payment: { verify: async () => ({ authorizationId: 'proof-interrupted', payload: {} }), settle: async () => { settles++; return { transaction: 'too-late' }; } },
  };
  try {
    const first = createOperationService(options).run('alice', key, 'Arc', {});
    // Allow the real SQL claim and authorization to complete before simulating process loss.
    await started.promise;
    assert.equal(searches, 1);
    assert.equal((await createOperationService(options).findByKey('alice', key))?.status, 'pending');
    now = new Date('2026-10-21T00:00:02Z');
    const recovered = await createOperationService(options).run('alice', key, 'Arc', {});
    assert.equal(recovered.status, 'unknown');
    gate.resolve(results);
    assert.equal((await first).status, 'unknown');
    assert.equal(searches, 1);
    assert.equal(settles, 0);
  } finally { gate.resolve(results); instance.close(); }
});

test('expired settling claim is unknown even when the original caller later sees success', async () => {
  const instance = database();
  const settlement = deferred<{ transaction: string }>();
  const started = deferred<void>();
  let now = new Date('2026-10-21T00:00:00Z');
  let settles = 0;
  const options = {
    db: instance.db, mode: 'live' as const, unitPriceAtomic: '1000', now: () => now, phaseTimeoutMs: 1000,
    search: async () => results,
    payment: { verify: async () => ({ authorizationId: 'proof-settling', payload: {} }), settle: async () => { settles++; started.resolve(); return settlement.promise; } },
  };
  try {
    const first = createOperationService(options).run('alice', key, 'Arc', {});
    await started.promise;
    assert.equal(settles, 1);
    assert.equal((await createOperationService(options).findByKey('alice', key))?.result, null);
    now = new Date('2026-10-21T00:00:02Z');
    const recovered = await createOperationService(options).findByKey('alice', key);
    assert.equal(recovered?.status, 'unknown');
    assert.equal(recovered?.result, null);
    settlement.resolve({ transaction: 'late-success' });
    assert.equal((await first).status, 'unknown');
    await createOperationService(options).run('alice', key, 'Arc', {});
    assert.equal(settles, 1);
  } finally { settlement.resolve({ transaction: 'late-success' }); instance.close(); }
});

test('explicitly ambiguous upstream errors stay unknown across repeated calls', async () => {
  const instance = database();
  let searches = 0;
  try {
    const service = createOperationService({ db: instance.db, search: async () => { searches++; throw new IndeterminateOperationError('remote execution may have completed'); } });
    const operation = await service.run('alice', key, 'Arc');
    assert.equal(operation.status, 'unknown');
    assert.deepEqual(await service.run('alice', key, 'Arc'), operation);
    assert.equal(searches, 1);
  } finally { instance.close(); }
});

test('inputs and public result sizes are bounded, unsafe URLs are rejected', async () => {
  const instance = database();
  try {
    const service = createOperationService({ db: instance.db, search: async () => Array.from({ length: 9 }, () => results[0]) });
    for (const input of ['', ' '.repeat(20), 'a'.repeat(501)]) await assert.rejects(service.run('alice', key, input), (error: unknown) => error instanceof OperationError && error.status === 400);
    for (const invalidKey of ['short', 'a'.repeat(129), 'unsafe key........']) await assert.rejects(service.run('alice', invalidKey, 'Arc'), (error: unknown) => error instanceof OperationError && error.status === 400);
    await assert.rejects(service.run('', key, 'Arc'), (error: unknown) => error instanceof OperationError && error.status === 401);
    assert.equal((await service.run('alice', key, 'Arc')).result?.results.length, 5);
    const unsafe = createOperationService({ db: instance.db, search: async () => [{ title: 'Unsafe', url: 'javascript:alert(1)', snippet: '' }] });
    assert.equal((await unsafe.run('alice', 'request-0000000002', 'Unsafe')).status, 'failed');
  } finally { instance.close(); }
});

test('list returns at most fifty owner records in deterministic newest-first order', async () => {
  const instance = database();
  try {
    let tick = Date.parse('2026-10-21T00:00:00Z');
    const service = createOperationService({ db: instance.db, search: async () => results, now: () => new Date(tick++) });
    for (let index = 0; index < 55; index++) await service.run('alice', `request-${String(index).padStart(10, '0')}`, `Arc ${index}`);
    const listed = await service.list('alice');
    assert.equal(listed.length, 50);
    assert.equal(listed[0].query, 'Arc 54');
    assert.equal(listed[49].query, 'Arc 5');
  } finally { instance.close(); }
});

test('live service fails closed without configured payment or canonical positive pricing', () => {
  const instance = database();
  try {
    assert.throws(() => createOperationService({ db: instance.db, mode: 'live', unitPriceAtomic: '1000', search: async () => results }), OperationError);
    for (const unitPriceAtomic of ['0', '01000', '-1', '1e6']) assert.throws(() => createOperationService({ db: instance.db, mode: 'live', unitPriceAtomic, search: async () => results, payment: { verify: async () => ({ authorizationId: 'proof', payload: {} }), settle: async () => ({ transaction: 'tx' }) } }), OperationError);
  } finally { instance.close(); }
});
