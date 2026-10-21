import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OperationError } from './core.ts';
import { createProviderProfileService, PROFILE_SCHEMA_SQL } from './provider.ts';
import { sqliteDatabase } from './testing/sqlite.ts';

const draft = {
  displayName: 'Small search provider',
  searchEndpoint: 'https://api.provider.com/search',
  payoutAddress: '0x1111111111111111111111111111111111111111',
  priceAtomic: '1000',
};

function database(path?: string) {
  const instance = sqliteDatabase(path);
  instance.sqlite.exec(PROFILE_SCHEMA_SQL);
  return instance;
}

function invalid(error: unknown) {
  return error instanceof OperationError && error.status === 400 && error.code === 'INVALID_PROVIDER_PROFILE';
}

test('provider draft is durable, isolated per owner and updated atomically', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spondion-provider-'));
  const path = join(directory, 'profiles.sqlite');
  let instance = database(path);
  try {
    let time = '2026-10-21T10:00:00.000Z';
    let service = createProviderProfileService(instance.db, () => new Date(time));
    assert.equal(await service.get('alice'), null);
    const first = await service.save('alice', draft);
    assert.deepEqual(first, { ...draft, updatedAt: time });
    assert.equal(await service.get('bob'), null);
    instance.close();
    instance = database(path);
    service = createProviderProfileService(instance.db, () => new Date(time));
    assert.deepEqual(await service.get('alice'), first);
    await service.save('bob', { ...draft, displayName: 'Another provider', priceAtomic: '2000' });
    time = '2026-10-21T11:00:00.000Z';
    const updated = await service.save('alice', { ...draft, displayName: 'Updated provider', priceAtomic: '100000000' });
    assert.equal(updated.updatedAt, time);
    assert.equal(updated.priceAtomic, '100000000');
    assert.equal((await service.get('bob'))?.displayName, 'Another provider');
    assert.equal(instance.sqlite.prepare('SELECT count(*) AS total FROM merchant_provider_profiles').get()?.total, 2);
  } finally { instance.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('incomplete provider draft saves without inventing payout, endpoint or price', async () => {
  const instance = database();
  try {
    const service = createProviderProfileService(instance.db);
    const value = await service.save('alice', { displayName: '  My API  ', searchEndpoint: '', payoutAddress: '', priceAtomic: '' });
    assert.equal(value.displayName, 'My API');
    assert.equal(value.searchEndpoint, '');
    assert.equal(value.payoutAddress, '');
    assert.equal(value.priceAtomic, '');
    assert.deepEqual(Object.keys(value).sort(), ['displayName', 'searchEndpoint', 'payoutAddress', 'priceAtomic', 'updatedAt'].sort());
  } finally { instance.close(); }
});

test('strict input rejects secrets, owner overrides and malformed fields without replacing saved draft', async () => {
  const instance = database();
  try {
    const service = createProviderProfileService(instance.db);
    const original = await service.save('alice', draft);
    const inputs: unknown[] = [null, [], 'draft', {}, { ...draft, ownerId: 'bob' }, { ...draft, apiKey: 'secret' }, { ...draft, facilitatorToken: 'secret' },
      { ...draft, displayName: 'x' }, { ...draft, displayName: 'x'.repeat(81) }, { ...draft, displayName: '<script>' },
      { ...draft, displayName: 'Provider\nAPI' }, { ...draft, displayName: 'Provider\u202e' }, { ...draft, searchEndpoint: null },
      { ...draft, payoutAddress: 123 }, { ...draft, priceAtomic: 1000 }, { ...draft, priceAtomic: undefined }];
    for (const input of inputs) await assert.rejects(service.save('alice', input), invalid);
    assert.deepEqual(await service.get('alice'), original);
    assert.equal(await service.get('bob'), null);
  } finally { instance.close(); }
});

test('provider endpoint validation blocks nonpublic, credential-bearing and secret-query URLs', async () => {
  const instance = database();
  try {
    const service = createProviderProfileService(instance.db);
    const endpoints = ['http://api.provider.com/search', 'https://user:secret@api.provider.com/search', 'https://api.provider.com/search?api_key=secret',
      'https://api.provider.com/search?', 'https://api.provider.com/search#secret', 'https://api.provider.com/search#', 'https://api.provider.com:8443/search',
      'https://localhost/search', 'https://api.localhost/search', 'https://127.0.0.1/search', 'https://0x7f000001/search', 'https://2130706433/search',
      'https://10.0.0.1/search', 'https://192.168.1.2/search', 'https://[::1]/search', 'https://api.local/search', 'https://api.internal/search',
      'https://api.test/search', 'https://api.example/search', 'https://api.invalid/search', 'https://api.provider.com./search',
      'https://api.provider.com/a b', 'https://api.provider.com/' + 'x'.repeat(501)];
    for (const searchEndpoint of endpoints) await assert.rejects(service.save('alice', { ...draft, searchEndpoint }), invalid, searchEndpoint);
    assert.equal(await service.get('alice'), null);
    assert.equal((await service.save('alice', { ...draft, searchEndpoint: 'HTTPS://API.PROVIDER.COM:443/search' })).searchEndpoint, draft.searchEndpoint);
  } finally { instance.close(); }
});

test('provider pricing stays exact and rejects unsafe amounts and payout addresses', async () => {
  const instance = database();
  try {
    const service = createProviderProfileService(instance.db);
    for (const priceAtomic of ['0', '-1', '01', '1.0', '0.001', '1e3', '+1', '100000001', '9007199254740993', '9'.repeat(1000)]) {
      await assert.rejects(service.save('alice', { ...draft, priceAtomic }), invalid);
    }
    for (const payoutAddress of ['0x' + '0'.repeat(40), '0x1234', '0X' + '1'.repeat(40), '0x' + 'g'.repeat(40), '0x' + '1'.repeat(41)]) {
      await assert.rejects(service.save('alice', { ...draft, payoutAddress }), invalid);
    }
    assert.equal((await service.save('alice', { ...draft, priceAtomic: '1' })).priceAtomic, '1');
  } finally { instance.close(); }
});

test('provider drafts use bound SQL and require a valid authenticated owner', async () => {
  const instance = database();
  try {
    const service = createProviderProfileService(instance.db);
    const label = "Provider'); DROP TABLE merchant_provider_profiles; --";
    assert.equal((await service.save('alice', { ...draft, displayName: label })).displayName, label);
    assert.equal(await service.get("alice' OR 1=1 --"), null);
    for (const ownerId of ['', ' ', 'x'.repeat(201)]) {
      await assert.rejects(service.get(ownerId), error => error instanceof OperationError && error.status === 401);
      await assert.rejects(service.save(ownerId, draft), error => error instanceof OperationError && error.status === 401);
    }
    assert.equal((await service.get('alice'))?.displayName, label);
  } finally { instance.close(); }
});
