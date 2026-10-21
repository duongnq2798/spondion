# Source provenance and verification

On 21 October 2026 the user approved an additional merchant workspace. The `merchant/`, `sdk/`, `worker/`, database migrations and provider UI were implemented and tested locally. These additions use Sites Worker/D1 hosting and maintained x402 SDKs; they have not been authored or validated in Arc Studio. They do not add a Mainnet transaction or establish grant eligibility.

The original application was generated and revised in [Arc Studio](https://studio.arc.io/app/5c8fa387-6104-4492-bce0-d9b93a71b81a). The final Studio export was retrieved on 21 October 2026. The Solidity product and test sources remain unchanged from that export and passed 72 independently rerun Foundry tests.

After Studio reported 100% of its daily allowance, final fixes were made locally: strict JSON integer validation, serialized withdrawal receipt accounting, isolated end-to-end tests, wallet amount/domain/role validation, voucher selection, account-change guards and persistent transaction tracking. A read-only unsigned deployment preparation script and wallet/backend regression tests were also added locally. Project metadata, configuration examples and documentation were corrected locally.

**The final local revision has not been synchronized to or tested in the active Studio application root.** Importing a repository into a Studio subdirectory would not complete that step. Do not claim that all final changes were authored or tested in Studio, or that grant eligibility is already established.

Fresh local evidence is in [final-verification/](final-verification/); logs under `evidence/` and `validation/` are historical Studio exports. Verification used only loopback Anvil 31337 with known disposable accounts and MockUSDC. AI output is deterministic word-count simulation. No paid model, public-chain transaction, user-wallet signature, gas payment or final grant submission occurred.

The production wallet build leaves the escrow address blank and writes disabled. A subsequent local [interface redesign](REDESIGN.md) was checked visually in the browser and exercised through the complete local fixture flow. Connected-wallet Mainnet execution remains unvalidated. No independent professional audit has been performed.
