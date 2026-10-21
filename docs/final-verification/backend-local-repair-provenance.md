# Backend repair and independent local verification

The baseline is the frozen Arc Studio export in `work/studio-current-09`. The delivered app contains explicitly authorized **local repairs**, recorded in [the patch](backend-local-repair.patch) and [before/after source hashes](backend-repair-source-hashes.json). These repairs must not be described as wholly Studio-authored. No Solidity contract source was changed.

| Check | Independent result | Evidence |
|---|---|---|
| Backend regressions before repair | 0 passed, 8 failed; separate stale-credit test also failed | [expected failures](backend-regressions-before.txt) |
| Backend regressions after repair | 9 passed, 0 failed; 36 expectations | [complete short log](backend-regressions-final.log) |
| Shipped E2E after repair | 103 passed, 0 failed; exit 0 | [complete log](e2e-independent-final.log) |
| Strict backend TypeScript | Passed, no diagnostics | [command and scope](backend-typecheck-final.txt) |

The backend now rejects JSON numbers before signing or writing; decimal amount fields and demo channel IDs retain their string types. Withdrawal credit is read inside the serialized write queue, and the response payout/amount come only from the matching ProviderWithdrawn event of a successful receipt. The regression test pauses local automining to prove that a queued 2000 settlement plus existing 1000 credit produces a 3000 event and a matching 3000 response; the original server incorrectly reported 1000.

The E2E starts two separate owned loopback Anvil nodes, validates chain 31337, refuses occupied ports, and requires actual backend status.ready with the expected RPC. Its contract fixture nonces/time cannot race backend startup. The deadline test mines settlement exactly at the signed deadline and checks the successful receipt and consumed voucher; at deadline plus one second it requires VOUCHER_EXPIRED and an unconsumed voucher. Completed fixture lifecycles must leave zero liabilities and zero escrow tokens.

Reproduce from the app directory using Bun 1.4.3 and Anvil 1.7.1 on PATH: `bun test server/backend-regression.test.ts`, `bun scripts/e2e-onchain.ts`, and `tsc --noEmit -p tsconfig.server.json`. Tooling is under `work/js-tooling`; `env.ps1` sets its local executables, caches and memory limits. E2E ports can be set with ANVIL_PORT, SERVER_ANVIL_PORT and API_PORT; they must be distinct and free.

These are local mock-EVM checks. They establish no public deployment, Arc-specific runtime behavior, professional audit, or real USDC payment. No public-chain signing, user wallet, real funds or secret credentials were used. Owned test processes were stopped; the explicit E2E ports were confirmed closed.
