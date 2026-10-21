# Spondion Merchant Search Implementation Plan

> Use subagent-driven development for independent modules and a whole-change review before publication.

**Goal:** Ship a hosted developer sandbox with durable search operations, a reusable merchant/client integration and standards-based x402 payment adapter, preserving the existing Arc escrow.

**Spec:** `../../../../docs/RESEARCH-AND-DECISION.md` and `../../../../docs/PROVIDER-PILOT.md` in the Spondion delivery folder. User approved implementation and publication on 21 October 2026.

**Architecture:** Existing React/Vite UI gains a merchant workspace. A Worker API and D1 store persist operations and results; ChatGPT platform identity scopes hosted sandbox records. An optional configured merchant API uses maintained x402 SDKs and a provider-owned search endpoint. Sandbox searches a documented local corpus, has no payments and is labelled accordingly. Live settlement remains disabled until real recipient/provider/facilitator configuration is supplied and a concrete money action is reviewed.

**Stack:** React 18, Vite 6, TypeScript, Cloudflare Worker/D1, x402 SDK, existing viem. Keep local Bun/Anvil server and Solidity unchanged.

## Constraints and review focus

- Do not edit Vestiarion, contract sources, fixture guards or original escrow handlers.
- Preserve Site identity and public audience; migration is additive and rollback retains D1 records.
- No private keys or credentials in browser/source. No paid external request or onchain settlement while testing.
- Exact monetary amounts are canonical decimal strings.
- Same request/payload must reuse persisted result/payment; changed payload with same key is rejected.
- Database atomic claim prevents concurrent duplicate execution. Interrupted upstream work becomes unresolved rather than assumed safe to repeat.
- Public sandbox data is isolated by platform user identity; unauthenticated writes fail with sign-in guidance. Bound body/query/list sizes.
- Real payment timeouts never become fresh payment attempts; require reconciliation of the original authorization.

## Tasks

- [x] 1. Durable operation module and meaningful SQLite-backed tests: duplicates, conflicts, restart recovery, cross-owner isolation, failures and ambiguous settlement.
- [x] 2. x402 adapter and TypeScript client example using maintained SDKs, tested without real network spending. Fail closed when live configuration is absent.
- [x] 3. Merchant workspace UI: real search form, replay button, persisted history/detail/receipt, clear sandbox labels, empty/error/auth states, responsive layout.
- [x] 4. Hosted Worker routes, D1 schema/migrations, search corpus and local preview. Preserve Arc tab.
- [ ] 5. Run module/integration tests and existing required checks, independent review, browser QA, publish exact checked source and update public GitHub/docs.

## Validation and rollback

Use real local SQLite/D1-compatible SQL for operation tests, stub only external API/facilitator boundaries. Verify 100 concurrent/repeated calls yield one execution/charge in tests, conflicts return 409, and restart does not re-charge. Test unauthenticated/cross-owner access. Browser QA must perform a search, replay, reload and inspect history.

Keep prior Site version 2 available; reverting to it restores the previous static interface without deleting new D1 data. Schema changes are additive only. Record the exact verification and remaining live-configuration limitations before publishing.

## Execution ledger

- Started: existing isolated Spondion app repository clean at `02c794007fcc2c140a8512371f572e8167065b24`; source helper opened the existing Site successfully. No shared Vestiarion checkout used.
- Implementation approval: user said “duyệt hết rồi đó, triển khai đi”; routine design and implementation choices proceed without another confirmation.
- Independent review: three P2s fixed and re-reviewed clean — price-change replay, SDK key-length mismatch and browser draft privacy. Core/SDK/HTTP use 40 tests, existing wallet validation 25; Solidity72, Anvil E2E103 and backend9 rerun. Final publication is handled by the root after packaging; see delivery report for hosted status.
