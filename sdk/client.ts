import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';

const NETWORK = 'eip155:8453';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** Store authorization headers as sensitive data; implementations must durably save before resolving. */
export interface MerchantAttempt {
  key: string;
  query: string;
  resourceUrl: string;
  paymentSignature?: string;
  state: 'prepared' | 'sent' | 'unknown' | 'responded';
}
export interface MerchantAttemptStore {
  get(key: string): Promise<MerchantAttempt | undefined>;
  set(key: string, attempt: MerchantAttempt): Promise<void>;
}
export interface MerchantClientConfig {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  paymentClient?: x402Client;
  attemptStore?: MerchantAttemptStore;
}
export interface MerchantClient {
  search(query: string, options: { idempotencyKey: string }): Promise<Response>;
  retry(idempotencyKey: string): Promise<Response>;
  findByKey(idempotencyKey: string): Promise<Response>;
  getOperation(operationId: string): Promise<Response>;
}

function endpoint(base: string): URL {
  const url = new URL(base);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) throw new Error('Merchant base URL must use HTTPS (HTTP is allowed only on loopback)');
  return new URL('/v1/search', url);
}
function validateKey(key: string) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) throw new Error('Use a stable request key of 16–128 letters, numbers, dots, underscores, colons or hyphens');
}
function memoryStore(): MerchantAttemptStore {
  const values = new Map<string, MerchantAttempt>();
  return { async get(key) { const value = values.get(key); return value ? structuredClone(value) : undefined; }, async set(key, value) { values.set(key, structuredClone(value)); } };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function unresolved(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    if (!object(body)) return false;
    const operation = object(body.operation) ? body.operation : body;
    const error = object(body.error) ? body.error : {};
    return operation.status === 'unknown' || operation.state === 'settlement_unknown' || body.code === 'settlement_unknown' || error.code === 'settlement_unknown' || error.code === 'operation_unknown';
  } catch { return false; }
}

/** No transport retries. Explicit retries bypass the payment wrapper and reuse saved authorization bytes. */
export function createMerchantClient(config: MerchantClientConfig): MerchantClient {
  const resource = endpoint(config.baseUrl);
  const rawFetch = config.fetch ?? globalThis.fetch;
  const store = config.attemptStore ?? memoryStore();
  const inFlight = new Map<string, { query: string; promise: Promise<Response> }>();
  const headers = () => {
    const result = new Headers({ 'Content-Type': 'application/json' });
    if (config.apiKey) result.set('Authorization', `Bearer ${config.apiKey}`);
    return result;
  };
  const submit = async (query: string, key: string, saved?: MerchantAttempt): Promise<Response> => {
    if (saved && (saved.query !== query || saved.resourceUrl !== resource.href)) throw new Error('Request key conflicts with a different payload or endpoint');
    if (saved?.state === 'unknown') throw new Error('Reconciliation required for the original unresolved settlement');
    let attempt: MerchantAttempt = saved ?? { key, query, resourceUrl: resource.href, state: 'prepared' };
    if (!saved) await store.set(key, attempt);
    const requestHeaders = headers(); requestHeaders.set('Idempotency-Key', key);
    if (attempt.paymentSignature) requestHeaders.set('PAYMENT-SIGNATURE', attempt.paymentSignature);
    const boundary: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const signature = request.headers.get('PAYMENT-SIGNATURE');
      if (signature) {
        if (attempt.paymentSignature && attempt.paymentSignature !== signature) throw new Error('A replacement payment authorization requires reconciliation');
        attempt = { ...attempt, paymentSignature: signature, state: 'sent' };
      } else attempt = { ...attempt, state: 'sent' };
      // Save the exact authorization before any potentially chargeable HTTP submission.
      await store.set(key, attempt);
      return rawFetch(request);
    };
    const send = !saved && config.paymentClient ? wrapFetchWithPayment(boundary, config.paymentClient) : boundary;
    const response = await send(resource, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ query, idempotencyKey: key }), redirect: 'error' });
    attempt = { ...attempt, state: await unresolved(response) ? 'unknown' : 'responded' };
    await store.set(key, attempt);
    return response;
  };
  const start = (query: string, key: string, saved?: MerchantAttempt): Promise<Response> => {
    const active = inFlight.get(key);
    if (active) {
      if (active.query !== query) return Promise.reject(new Error('Request key conflicts with a different payload'));
      return active.promise.then(response => response.clone());
    }
    const promise = (async () => submit(query, key, saved ?? await store.get(key)))();
    inFlight.set(key, { query, promise });
    void promise.finally(() => inFlight.delete(key)).catch(() => {});
    return promise.then(response => response.clone());
  };
  const read = (url: URL) => rawFetch(url, { method: 'GET', headers: headers(), redirect: 'error' });
  return {
    async search(query, { idempotencyKey }) {
      validateKey(idempotencyKey);
      if (!query.trim() || query.length > 500) throw new Error('Query must contain 1–500 characters');
      return start(query, idempotencyKey);
    },
    async retry(key) {
      validateKey(key);
      const saved = await store.get(key);
      if (!saved) throw new Error('Unknown request key; reconcile by finding the original operation before retrying');
      return start(saved.query, key, saved);
    },
    async findByKey(key) {
      validateKey(key);
      const url = new URL('/v1/operations', resource); url.searchParams.set('key', key);
      return read(url);
    },
    async getOperation(id) {
      if (!id || id.length > 128) throw new Error('Invalid operation ID');
      return read(new URL(`/v1/operations/${encodeURIComponent(id)}`, resource));
    },
  };
}

export interface X402MerchantClientConfig extends Omit<MerchantClientConfig, 'paymentClient'> {
  signer: ConstructorParameters<typeof ExactEvmScheme>[0];
  recipient: string;
  maxAmountAtomic: string;
}

/** Supported EOA exact/Base USDC profile; no key is accepted, stored or sent by this SDK. */
export function createX402MerchantClient(config: X402MerchantClientConfig): MerchantClient {
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.recipient) || /^0x0{40}$/i.test(config.recipient)) throw new Error('Invalid reviewed recipient');
  if (!/^[1-9][0-9]*$/.test(config.maxAmountAtomic) || config.maxAmountAtomic.length > 78) throw new Error('A positive canonical maximum atomic amount is required');
  const resourceUrl = endpoint(config.baseUrl).href;
  const paymentClient = new x402Client().register(NETWORK, new ExactEvmScheme(config.signer));
  paymentClient.registerPolicy((version, requirements) => version === 2 ? requirements.filter(requirement =>
    requirement.scheme === 'exact' && requirement.network === NETWORK &&
    requirement.asset.toLowerCase() === USDC &&
    requirement.payTo.toLowerCase() === config.recipient.toLowerCase() &&
    /^[1-9][0-9]*$/.test(requirement.amount) &&
    BigInt(requirement.amount) <= BigInt(config.maxAmountAtomic) &&
    Number.isInteger(requirement.maxTimeoutSeconds) && requirement.maxTimeoutSeconds > 0 && requirement.maxTimeoutSeconds <= 300 &&
    requirement.extra.name === 'USD Coin' && requirement.extra.version === '2' &&
    (requirement.extra.assetTransferMethod === undefined || requirement.extra.assetTransferMethod === 'eip3009') &&
    (requirement.extra.paymentFlow === undefined || requirement.extra.paymentFlow === 'authorization'),
  ) : []);
  paymentClient.onBeforePaymentCreation(async ({ paymentRequired }) => {
    if (paymentRequired.resource?.url !== resourceUrl) return { abort: true, reason: 'Payment resource URL does not match the configured merchant endpoint' };
    if (paymentRequired.extensions !== undefined) return { abort: true, reason: 'Unreviewed payment extensions are not supported' };
  });
  return createMerchantClient({ ...config, paymentClient });
}
