import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorConfig } from '@x402/core/server';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import type { PaymentAdapter, PaymentContext, VerifiedPayment } from './types.ts';

export const X402_NETWORK = 'eip155:8453' as const;
export const X402_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export interface X402Config {
  liveEnabled?: boolean;
  recipient?: string;
  facilitatorUrl?: string;
  resourceUrl: string;
  priceAtomic: string;
  createAuthHeaders?: FacilitatorConfig['createAuthHeaders'];
  timeoutMs?: number;
}
export interface X402Challenge { body: PaymentRequired; header: string }
export interface X402PaymentAdapter extends PaymentAdapter {
  requirements(url?: string): Promise<X402Challenge>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function address(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
}
function integer(value: unknown, positive = false): value is string {
  return typeof value === 'string' && value.length <= 78 && (positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/).test(value);
}
function secureUrl(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label} configuration`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`Invalid ${label} configuration: use an HTTPS URL without credentials or fragment`);
  return url.href;
}
function assertContext(context: PaymentContext, price: string) {
  if (context.amountAtomic !== price || context.unitPriceAtomic !== price || context.units !== 1) throw new Error('Operation amount does not match configured unit price');
}
function contextKey(context: PaymentContext): string {
  return JSON.stringify([context.operationId, context.ownerId, context.query, context.amountAtomic, context.unitPriceAtomic, context.units]);
}

/** No private key or signer is constructed by the merchant. HTTPFacilitatorClient uses Worker fetch. */
export function createX402PaymentAdapter(config: X402Config): X402PaymentAdapter {
  if (config.liveEnabled !== true) throw new Error('Live payments are disabled by configuration');
  if (!address(config.recipient)) throw new Error('Invalid recipient configuration');
  if (!integer(config.priceAtomic, true)) throw new Error('Invalid positive atomic price configuration');
  const recipient = config.recipient;
  const resourceUrl = secureUrl(config.resourceUrl, 'resource URL');
  const facilitatorUrl = secureUrl(config.facilitatorUrl, 'facilitator URL');
  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl, createAuthHeaders: config.createAuthHeaders, timeoutMs: config.timeoutMs });
  const server = new x402ResourceServer(facilitator).register(X402_NETWORK, new ExactEvmScheme());
  let prepared: Promise<{ accepts: PaymentRequirements[]; body: PaymentRequired }> | undefined;
  const prepare = () => prepared ??= (async () => {
    await server.initialize();
    const accepts = await server.buildPaymentRequirements({
      scheme: 'exact', network: X402_NETWORK, payTo: recipient,
      price: { amount: config.priceAtomic, asset: X402_USDC, extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' } },
      maxTimeoutSeconds: 300,
    });
    const body = await server.createPaymentRequiredResponse(accepts, { url: resourceUrl, description: 'One search request', mimeType: 'application/json' });
    return { accepts, body };
  })();
  const verifiedHandles = new Map<string, { authorizationId: string; payload: PaymentPayload; requirement: PaymentRequirements; context: string }>();
  const attempted = new Set<string>();
  return {
    async requirements(url = resourceUrl) {
      if (url !== resourceUrl) throw new Error('Resource URL does not match configured paid endpoint');
      const { body } = await prepare();
      return { body: structuredClone(body), header: encodePaymentRequiredHeader(body) };
    },
    async verify(input, context) {
      assertContext(context, config.priceAtomic);
      const decoded: unknown = typeof input === 'string' ? decodePaymentSignatureHeader(input) : input;
      if (!record(decoded) || decoded.x402Version !== 2 || !record(decoded.accepted) || !record(decoded.payload)) throw new Error('Invalid x402 v2 payment');
      if (!record(decoded.resource) || decoded.resource.url !== resourceUrl) throw new Error('Payment resource URL mismatch');
      const accepted = decoded.accepted;
      if (accepted.scheme !== 'exact' || accepted.network !== X402_NETWORK || accepted.asset !== X402_USDC || accepted.payTo !== recipient || accepted.amount !== config.priceAtomic || accepted.maxTimeoutSeconds !== 300 || !record(accepted.extra)) throw new Error('Payment requirements mismatch');
      const authorization = decoded.payload.authorization;
      if (!record(authorization) || !address(authorization.from) || !address(authorization.to) || authorization.to.toLowerCase() !== recipient.toLowerCase() || authorization.value !== config.priceAtomic || !integer(authorization.validAfter) || !integer(authorization.validBefore) || BigInt(authorization.validBefore) <= BigInt(authorization.validAfter) || typeof authorization.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce) || typeof decoded.payload.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(decoded.payload.signature) || Object.keys(decoded.payload).some(key => key !== 'signature' && key !== 'authorization')) throw new Error('Unsupported or invalid EIP-3009 authorization');
      if (decoded.extensions !== undefined) throw new Error('Payment extensions are not supported by this adapter');
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: resourceUrl, description: typeof decoded.resource.description === 'string' ? decoded.resource.description : '', mimeType: 'application/json' },
        accepted: { scheme: 'exact', network: X402_NETWORK, asset: X402_USDC, amount: config.priceAtomic, payTo: recipient, maxTimeoutSeconds: 300, extra: accepted.extra },
        payload: structuredClone(decoded.payload),
      };
      const { accepts } = await prepare();
      const requirement = server.findMatchingRequirements(accepts, payload);
      if (!requirement) throw new Error('Payment requirements mismatch');
      const result = await server.verifyPayment(payload, requirement);
      if (!result.isValid || result.skipHandler || (result.payer && result.payer.toLowerCase() !== authorization.from.toLowerCase())) throw new Error('Payment verification failed');
      const verificationToken = crypto.randomUUID();
      const verified: VerifiedPayment = { authorizationId: `${X402_NETWORK}:${authorization.from.toLowerCase()}:${authorization.nonce.toLowerCase()}`, payload: { verificationToken, payment: payload } };
      verifiedHandles.set(verificationToken, { authorizationId: verified.authorizationId, payload: structuredClone(payload), requirement: structuredClone(requirement), context: contextKey(context) });
      return verified;
    },
    async settle(verified, context) {
      assertContext(context, config.priceAtomic);
      const token = record(verified.payload) && typeof verified.payload.verificationToken === 'string' ? verified.payload.verificationToken : '';
      const handle = verifiedHandles.get(token);
      if (!handle || handle.context !== contextKey(context) || handle.authorizationId !== verified.authorizationId) throw new Error('Payment verification identity or operation context mismatch');
      if (attempted.has(handle.authorizationId)) throw new Error('Settlement already attempted; reconcile the original authorization');
      attempted.add(handle.authorizationId);
      // The resource-server settle helper may reconcile settlement_pending by calling settle twice.
      // This integration delegates reconciliation to its durable operation state, so submit once.
      const result = await facilitator.settle(handle.payload, handle.requirement);
      if (!result.success || result.network !== X402_NETWORK || !/^0x[0-9a-fA-F]{64}$/.test(result.transaction)) throw new Error('Settlement is unresolved; reconcile the original authorization');
      return { transaction: result.transaction };
    },
  };
}

export async function createX402Requirements(config: X402Config, url?: string): Promise<X402Challenge> {
  return createX402PaymentAdapter(config).requirements(url);
}

/** Reconstruct only a confirmed persisted receipt, including on a completed operation replay. */
export function createX402SettlementHeader(transaction: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transaction)) throw new Error('Invalid confirmed settlement transaction');
  return encodePaymentResponseHeader({ success: true, transaction, network: X402_NETWORK });
}
