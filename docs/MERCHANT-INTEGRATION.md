# Merchant integration

The hosted Merchant Workspace is a **free sandbox**. It searches a bundled local corpus, stores operations in D1 and never asks for a payment. It does not call a commercial search API. The optional `/v1` integration is a separate, disabled-by-default provider API. The existing Arc escrow is independent of this x402 adapter.

## Scope and trust

This prototype supports x402 v2 `exact` payments using native EIP-3009 USDC on **Base Mainnet (`eip155:8453`)**, from an externally owned account. It uses pinned `@x402/core`, `@x402/evm` and `@x402/fetch` version 2.28.0. Permit2, smart-account extensions, batch payments, other networks and Arc compatibility have not been implemented or validated.

The `/v1` routes require the provider's `SPONDION_MERCHANT_API_KEY` as a Bearer credential. This is a **single-merchant, provider-owned integration**, not a public multi-tenant payer gateway. The authenticated provider is the durable operation owner. A USDC authorization proves the wallet authorized a transfer to the recipient, for the specified amount and nonce. It does not bind the search query or establish that a search was delivered. The provider must keep its API key private and control who may submit payment authorizations under that scope.

## Server configuration

Configure Worker secrets and variables through the hosting provider, never in `VITE_*`, committed files or the browser:

| Setting | Purpose |
|---|---|
| `SPONDION_LIVE_ENABLED=true` | Explicitly enables the optional paid API after configuration and operational review |
| `SPONDION_MERCHANT_API_KEY` | High-entropy provider Bearer credential |
| `SPONDION_PAY_TO` | Provider's reviewed Base USDC recipient address |
| `SPONDION_PRICE_ATOMIC` | Positive canonical integer string for one search; USDC has six decimals |
| `SPONDION_RESOURCE_URL` | Fixed absolute HTTPS URL of this deployment's `/v1/search` |
| `SPONDION_FACILITATOR_URL` | Explicit facilitator base URL supporting exact/Base EIP-3009 |
| `SPONDION_FACILITATOR_AUTH_HEADER` | Optional facilitator `Authorization` value, such as a provider-issued Bearer credential |
| `SPONDION_UPSTREAM_SEARCH_URL` | Provider-owned search endpoint |
| `SPONDION_UPSTREAM_API_KEY` | Upstream credential, if required by that endpoint |

Missing recipient, facilitator or enable flag fails closed. The resource server initializes against the facilitator's `/supported` response and rejects a missing supported payment kind. Facilitator authentication is separate from the merchant API key: the Worker maps its optional facilitator authorization secret to the SDK's endpoint-scoped headers. The adapter also accepts the maintained SDK's `createAuthHeaders` callback for per-endpoint authentication. Supply a server secret integration when your facilitator requires signed or rotating credentials; a static Bearer value does not implement a facilitator's JWT-signing requirements. Do not assume the public development facilitator permits mainnet settlement.

The upstream must implement the request/result contract documented by the Worker and support this provider's request identity. Configure a commercial upstream only after reviewing its own pricing and behavior. No search-provider cost, facilitator fee, gas cost, throughput or production economics has been estimated here. The fixed merchant amount is a configuration input, not a cost estimate.

## HTTP contract

`POST /v1/search` accepts JSON `{ "query": "payment channels", "idempotencyKey": "your-stable-request-id" }`. The key must contain 16–128 characters, start with a letter or digit, and use only letters, digits, dots, underscores, colons or hyphens. Send the same key as `Idempotency-Key`. The SDK rejects invalid keys before network access or signing. The API responds with an official x402 `PAYMENT-REQUIRED` header and v2 body when authorization is needed. The caller signs locally and resends the same logical request with `PAYMENT-SIGNATURE`. Successful x402 settlement information is returned in `PAYMENT-RESPONSE` when available.

Use `GET /v1/operations?key=<idempotencyKey>` to find the original operation after a lost response, or `GET /v1/operations/<operationId>` when its ID is known. Both require the same provider credential. Reusing a key with a changed query is a conflict. Completed requests reuse the persisted result; concurrent claims do not execute or settle twice. An interrupted execution or uncertain settlement is retained as unresolved. No background process automatically repeats an uncertain money action.

## TypeScript caller

`sdk/client.ts` provides `createMerchantClient` for a supplied x402 client and `createX402MerchantClient` for the supported exact/Base signer. The latter pins the recipient, native Base USDC asset, resource URL and a maximum atomic amount before asking the caller to sign. A private key is never sent to the merchant, facilitator or browser. `examples/merchant-client.ts` reads a private key from the caller's environment and refuses to make a request unless `SPONDION_ALLOW_PAID_REQUEST=true` is explicitly set at runtime. That example has **not been executed** as part of this work.

```ts
const client = createX402MerchantClient({
  baseUrl: 'https://your-merchant.example',
  apiKey: providerApiKey,
  signer: callerOwnedAccount,
  recipient: reviewedRecipient,
  maxAmountAtomic: '1000',
});
const response = await client.search('payment channels', {
  idempotencyKey: yourDurableRequestId,
});
```

There are no automatic transport retries. The first 402 challenge can cause one local authorization and one paid HTTP submission. The client saves that exact payment header before sending it. If the HTTP response is lost, `retry(key)` reuses the same body, key and authorization bytes; it never generates a replacement nonce. A returned unknown operation state disables retry and requires reconciliation of the original operation and transaction through the provider/facilitator. The adapter also refuses a second settlement submission for the same nonce. Verification tokens survive the operation store's JSON boundary within the active request; a new adapter instance cannot resume a settlement after restart, and the durable service preserves that interrupted operation as unresolved.

Keep the client instance alive for retries. For process restarts, supply a durable `attemptStore` implementing the exported interface; treat stored payment headers as sensitive, short-lived authorizations and restrict access. Without the original saved state, retrieve the original operation with `findByKey(key)` before taking further action. Never create a new key or fresh authorization merely because a request timed out. Do not run multiple processes against one saved attempt without an external lock; the server's durable claim remains the final execution guard.

## Provider setup and recovery

Provider drafts and read-only settlement recovery are now available. [Provider setup and recovery](PROVIDER-ONBOARDING.md) documents the account-scoped draft API and authenticated `POST /v1/operations/:id/reconcile`. Recovery checks the original finalized Base USDC receipt without submitting another payment. Drafts do not change these single-merchant runtime settings or enable live charges. Operator history reads and recovery remain available when live charging is disabled, provided the merchant API credential remains configured.

## Validation boundary

Automated tests use real x402 challenge/header helpers and maintained client/server classes with a fake HTTP boundary. Integrated tests send the SDK's actual JSON and payment headers through the Worker handler and durable core into real SQLite. They check completed-result recovery after a lost response, 16- and 128-character request keys, HTTP 409 payload conflicts and HTTP 503 unknown settlement across client restart. Only external facilitator/provider HTTP responses are intercepted in those integrated tests. The signer used by tests emits fake data and never signs with a wallet. No paid external requests or onchain transactions were performed. This establishes local integration behavior, not a successful live Base payment. Recipient ownership, facilitator production access, upstream service and recovery procedures still need a controlled deployment-specific validation before enabling paid operation.

Primary references: [x402 core](https://www.npmjs.com/package/@x402/core), [EVM package](https://www.npmjs.com/package/@x402/evm), [fetch package](https://www.npmjs.com/package/@x402/fetch), [maintained repository](https://github.com/x402-foundation/x402).
