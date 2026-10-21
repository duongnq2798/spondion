# Provider onboarding and recovery — 21 October 2026

The Merchant Workspace now offers account-scoped provider setup with a saved metadata draft, exact six-decimal USDC price, readiness checklist and server settings template. Saving a draft keeps live payments disabled. No upstream credentials or signing keys are accepted by this form.

The operator API can recover an original unknown x402 settlement by checking its finalized canonical Base receipt. It matches the original EIP-3009 nonce and adjacent USDC authorization/transfer events, atomically confirms the existing record, and exposes the previously saved result. It never submits a payment. Saved operator reads and recovery remain accessible during a live-charge shutdown.

## Verification

| Check | Fresh result |
|---|---|
| Merchant/core/SDK/Worker | 67 passed, 0 failed; 27 added since the initial merchant release |
| Recovery-specific | 18 tests, including pinned read-only RPC methods, finality, canonicality, wrong payment fields, owner isolation, uncertainty and concurrency |
| Provider-specific | 6 real-SQLite tests, including durable reopen, per-owner isolation, strict metadata, endpoints and price bounds |
| Worker integration | 9 tests; includes authenticated drafts, shutdown recovery guards and migration over an existing receipt |
| Wallet validation | 25 passed |
| Solidity | 72 passed, including 3 fuzz cases with 256 runs each |
| Backend | 9 passed, 36 expectations |
| Local Anvil E2E | 103 assertions passed |
| TypeScript | Frontend, Bun backend, merchant/SDK/Worker all passed |
| Production build | Worker and client build passed; finalized hosting manifest/migrations verified |
| Independent review | No actionable issues found in backend, migration or provider UI |
| Local browser | Saved a fixture draft, restored it after reload, preserved 1 atomic unit from 0.000001 USDC, and rejected seven-decimal input |

The default E2E port was occupied, so the successful rerun used separate owned loopback ports 28545/28546/23001. No existing process was stopped to free the default port. The migration regression initially expected a JSON null for optional evidence; it was corrected to the documented omitted-field shape and confirms the database column remains null. Build warnings remain dependency annotation notices and large wallet chunks; Node reports experimental SQLite.

## Deployment and limits

The new schema-only migration adds the provider table and nullable evidence column. The prior Worker version 3 is the rollback target; retain the additive schema and migration history when reverting. This update adds no dependency and leaves Arc contract code and local fixture safeguards unchanged.

Tests use synthetic payment receipts and intercepted RPC responses. They do not prove a successful live Base payment or provider economics. Provider drafts are preparation for the existing operator-managed integration, not live multi-tenant accounts. No outside provider or paying user has been onboarded. The public documentation sandbox continues to charge zero.

No real transaction, wallet signature, gas payment or final grant submission was performed. Arc Mainnet evidence and final Studio synchronization remain pending, and the earlier MetaMask URL warning remains unresolved. Hosted publication identifiers and final browser checks are recorded separately in the delivery folder after publication.
