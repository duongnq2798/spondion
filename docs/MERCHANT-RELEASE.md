# Merchant workspace release — 21 October 2026

This records the initial merchant release. The subsequent onboarding and recovery update is documented in [Provider release verification](PROVIDER-RELEASE.md), including the newer test totals and rollback target.

## Delivered behavior

- The default provider workspace runs real searches over a fixed Spondion documentation corpus. It saves operations and results in D1, scoped to ChatGPT platform identity. The sandbox charges zero and makes no paid API calls.
- Same-key retry recovers a saved operation. An altered query conflicts. Auth loss clears the previous user's form/history; drafts are no longer stored in browser session storage.
- A reusable TypeScript client and maintained x402 2.28 adapter support the optional single-merchant exact/USDC/Base integration. Recipient/asset/price/resource are checked, the original authorization is retained across retries, and settlement is submitted once.
- Atomic SQL claims and a globally unique network/payer/nonce prevent duplicate work and reuse of one payment proof. Results are concealed until success. Unknown outcomes persist for manual reconciliation rather than silently charging again.
- Existing Arc wallet and Anvil fixture interfaces remain available. Contract source and local-server safeguards were not changed. The standalone E2E runner now exits on success after stopping its owned fixture processes; Bun/Windows had retained open RPC/pipe handles.

## Fresh verification

| Check | Result |
|---|---|
| Durable merchant core | 14 tests passed |
| x402 adapter and SDK | 20 tests passed, including SDK → actual HTTP handler → SQLite |
| Worker/API/search | 6 tests passed against the generated migration |
| Existing wallet validation | 25 tests passed |
| Combined Node suite | **65 passed, 0 failed** |
| Solidity | **72 passed**, 3 fuzz cases × 256 runs |
| Local Anvil E2E | **103 assertions passed**, successful runner exit after cleanup fix |
| Backend regressions | **9 passed**, 36 expectations |
| TypeScript | Frontend, Bun backend and merchant/Worker configurations checked |
| Local browser | Sign in, search, retry, one saved row, reload recovery, sign out clearing query/results/history |

The 100-duplicate test runs two service instances against real SQLite and observes one verification/search/settlement. SDK HTTP integrations intercept only external facilitator and provider boundaries; they do not execute real payments. No production conformance certification or security audit is implied.

## Deployment and rollback

The existing public Site identity is preserved. Build output is Worker ESM plus client assets, with the Sites build/auth integration and a managed `DB` binding. One schema-only Drizzle migration adds operations and daily sandbox admission limits. The previous static Site version 2 remains the rollback target; reverting application code does not remove D1 records.

Compatibility date is pinned to 2026-05-15 to match the installed Workers runtime. Build diagnostics include dependency annotation notices, large wallet chunks and Node's experimental SQLite warning. A test-only Solidity local variable shadowing warning is unchanged.

Publication IDs and final hosted verification are recorded separately in the delivery folder after the native deployment succeeds.

## Material limits

- The hosted sandbox is documentation search, not a live web-search provider. No external provider or paying customer has been onboarded.
- `/v1` fails closed until actual merchant credentials, provider endpoint/key, payout, pricing and production facilitator are configured. The public testnet facilitator is not a default Mainnet solution.
- An unknown operation needs manual reconciliation; there is no automated background onchain reconciliation worker in this release. Upstream exactly-once execution is not guaranteed without provider support.
- No Mainnet escrow, real USDC transfer, paid upstream call, real-wallet signature or grant submission occurred. MetaMask's prior URL warning remains unresolved. Final Studio-root integration is still pending, and the new merchant modules were built locally.
- This is a testable beta foundation, not a declaration of production financial readiness or grant eligibility.
