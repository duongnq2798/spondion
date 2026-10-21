# Spondion architecture

The default **merchant workspace** is React → same-origin Cloudflare Worker → D1. Its sandbox searches Spondion documentation with zero charges. ChatGPT platform user IDs scope stored records; anonymous writes and history access are rejected. The loopback preview uses the Sites starter's local mock identity, never a production authentication cookie.

Two original interfaces remain connected to the non-upgradeable Arc escrow:

| Mode | Execution and signing | Current scope |
|---|---|---|
| Local demo | React → Vite `/api` proxy → Bun backend → owned Anvil, MockUSDC and escrow | Real fixture EIP-712 signatures and transactions; mocked AI response/word-count metering |
| Wallet | React/wagmi/viem → connected wallet → configured chain and escrow | Arc Mainnet defaults; writes gated until a reviewed escrow address is configured |

Wallet mode does not poll the local backend. Fixture keys belong only in the local server/E2E code and must never enter browser bundles. Production Studio trace/console forwarding is guarded off; this does not claim all third-party wallet SDK analytics is disabled.

## Merchant operations and payment adapter

`merchant/core.ts` and `store.ts` maintain atomic SQL claims, owner/key uniqueness and globally unique payment authorization IDs. A logical request persists authorization, result and settlement phases. Completed results survive reload/restart. Pending, unknown and failed operations do not expose stored results. Expired authorizing/executing/settling claims become unknown after 120 seconds when read; they never automatically rerun work or settlement. Unknown payments require manual reconciliation before any new payment is considered. An upstream action cannot be promised exactly-once without matching support from that provider.

`worker/api.ts` provides authenticated `/api/merchant` sandbox routes, bounded input, owner isolation, no-store responses and atomic per-user daily admission limits. `db/schema.ts` generates additive D1 migrations under `drizzle/`. No request handler creates tables. `worker/search.ts` indexes a fixed project-doc corpus; configured provider search is a bounded server-side HTTPS request, never a fetch of a URL supplied by the query.

`merchant/x402.ts` uses maintained x402 2.28 SDKs for EOA EIP-3009 exact USDC on Base. It validates recipient/asset/amount/resource, binds each verified proof to its operation and submits settlement once. `sdk/client.ts` retains the logical request and payment bytes across explicit retry/restart, checks its recipient/budget before signing and blocks retries of an unknown outcome. `/v1` is a single-merchant integration guarded by a server-only merchant API credential. Live mode fails closed until recipient, price, facilitator and upstream configuration are all present. No real x402 payment has been executed.

The Site now deploys a Worker plus client assets using the existing Sites plugin and a provisioned `DB` binding. Wrangler compatibility is pinned to 2026-05-15 because the installed runtime supports dates only through 2026-05-22; this is a runtime feature pin, not the release date. Existing static version 2 can be redeployed as rollback without deleting the new D1 records. The added SDK/Worker/UI code is local work and remains outside the pending Studio-root synchronization.

## Provider onboarding and settlement recovery

The Merchant Workspace now includes **Provider setup**. `merchant/provider.ts` stores only a signed-in user's non-secret metadata in `merchant_provider_profiles`: service name, public HTTPS endpoint, Base recipient and exact USDC price. `GET/POST /api/merchant/provider` use the same platform identity and same-origin write protection as sandbox operations. Saving a draft never fetches an endpoint, changes global runtime settings, creates credentials or enables payments. The UI keeps unsaved values in memory, clears them on auth loss and generates a server settings template with live payments off. This is a preparation workflow for the existing single-merchant deployment, not a self-service multi-tenant payment gateway.

`merchant/reconcile.ts` handles operator-triggered, read-only `POST /v1/operations/:id/reconcile`. Only a live unknown operation with its saved search result and original verified EIP-3009 payment can be recovered. A fixed Base RPC reader checks the chain, finalized head and canonical successful receipt, then matches official USDC `AuthorizationUsed` and the immediately following `Transfer` against the original payer, nonce, recipient and amount. An atomic compare-and-set records safe evidence in `reconciliation_json`, confirms the original amount and exposes the saved result. Replays return the same proof; mismatches and RPC uncertainty leave the unknown state intact. The endpoint never signs or calls settlement. Operator receipt reads and recovery remain accessible with the merchant credential even while new live charges are disabled.

Additive migration `0001_simple_joystick.sql` creates the profile table and nullable evidence column. It preserves existing operations. Prior Worker version 3 can be redeployed while retaining both additions. See [provider setup and recovery](PROVIDER-ONBOARDING.md) for the HTTP contract and limits.

## Contract and trust model

`Active → requestClose → Closing → finalizeRefund → Closed`. An active channel accepts deposits and provider settlements. Closing permits settlement strictly before `refundAvailableAt`; refund requires a timestamp at or after it.

The signer authorizes `channelId`, `requestId`, `units` and `deadline` under an EIP-712 domain bound to chain ID and escrow address. A consumed-request mapping prevents replay, including after top-up. The voucher deadline is inclusive. The contract applies channel price, per-call and lifetime caps, available balance, provider identity and signer authorization.

**A signed voucher is not a reservation.** Outstanding vouchers share the channel's balance and remaining lifetime cap. Earlier valid settlements can make later ones unpayable. At the exact closing refund boundary, settlement is rejected and refund becomes eligible. Providers must account for this collection risk in their agreement and settle before that boundary.

There is **no metering oracle** and no proof of completed AI/API work. The demo uses word count; the real application must define who measures units and who is trusted to sign them. Signatures authenticate authorization, not service quality or delivery.

Accounting requires `USDC.balanceOf(escrow) >= totalLiabilities`, where liabilities equal channel balances plus payout credits. Settlement moves value from channel balance to payout credit; withdrawal/refund transfers tokens and reduces liabilities. The contract has no proxy or administrative drain. Recovery from a contract bug requires a new deployment and voluntary channel migration.

## Backend safeguards and repairs

The backend binds to loopback, checks allowed browser origins, and verifies chain 31337 before signing/writing or changing fixture time. It deploys from compiled artifacts, funds fixture accounts, and only then reports `/status.ready: true`. `/health` alone does not establish readiness.

- Amounts and demo channel IDs must be decimal strings; numeric JSON values are rejected before a transaction. Leading-zero amounts are rejected.
- Writes run through one queue. Withdrawal credit is read inside that queue, and response payout/amount come from `ProviderWithdrawn` in a successful matching receipt.
- Channel IDs come from `ChannelOpened`; settlement amounts/history come from receipt events or on-chain logs.
- Voucher deadlines and grace skips use chain time. The local server constructor uses **3,600 seconds** of grace.

The E2E owns separate Anvil instances for direct contract tests and backend tests, isolating fixture nonces and time. It checks actual status readiness, exact deadline success, deadline-plus-one rejection and zero remaining fixture liabilities/tokens.

## Verification and provenance

Independent checks passed **72 Solidity tests, 103 E2E assertions, 9 backend regressions and 25 wallet-validation tests**, plus strict backend/frontend typechecks. These are local validations, not mainnet or connected-wallet payment evidence. No independent professional audit has been performed.

The contract source is unchanged from the Studio export. The final frontend/backend repairs and unsigned deployment helper were added locally after Studio AI quota was exhausted. **Final Studio synchronization remains pending**; see [repair provenance](../../evidence/backend-local-repair-provenance.md).

Runtime prerequisites are Node.js 24+, Bun 1.4.3 and Forge/Anvil. The reviewed build uses Solc **0.8.28**, Paris EVM and optimizer 200, with OpenZeppelin **5.1.0**. Standard Anvil/MockUSDC cannot establish Arc-specific native/ERC-20 USDC behavior.

## Main files

The redesigned interface uses a responsive navigation shell in `src/App.tsx` and evergreen/lime design tokens in `src/index.css`. Wallet connection, deployment status and the funding/usage/refund guide are separate presentation panels. The local demo presents numbered workflows with channel and settlement tables. The redesign preserves existing wallet authorization handlers, API calls, chain guards and exact amount validation; it adds no dependencies or simulated production balances. Studio attribution remains visible. See [redesign verification](REDESIGN.md).

| Path | Purpose |
|---|---|
| `contracts/SpondionPrepaidEscrow.sol` | Studio-origin escrow source |
| `contracts/test/` | MockUSDC and Solidity regression/fuzz tests |
| `server/index.ts`, `server/backend-regression.test.ts` | Local fixture API and real HTTP-to-EVM regressions |
| `src/components/WalletView.tsx`, `src/lib/validation.ts` | Wallet flow and exact input/voucher validation |
| `scripts/e2e-onchain.ts` | Owned local-chain contract/API checks |
| `scripts/prepare-mainnet.ts` | Unsigned creation data with constructor/source checks |

Copy `.env.example` for local configuration. The unsigned Arc demo draft uses **300 seconds**, independently of the server's 3,600-second default. Neither is a reviewed production grace recommendation. No mainnet deployment or real USDC payment has been completed.
