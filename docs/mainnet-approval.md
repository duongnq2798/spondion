# Mainnet review and unsigned deployment

**No mainnet deployment or real USDC payment has been completed.** The local demo uses owned Anvil fixtures; no public-network wallet signing or broadcast was performed. Leave `VITE_ESCROW_ADDRESS` empty until an approved deployment has been verified.

The escrow contract source is unchanged from the Studio export. Final frontend/backend repairs and deployment preparation were made locally after Studio AI quota was exhausted. **Final Studio synchronization is pending**; do not describe this delivery as wholly Studio-authored. See [repair provenance](../../evidence/backend-local-repair-provenance.md).

## What has been checked

Independent local results: **72 Solidity tests, 103 E2E assertions, 9 backend regressions and 25 wallet-validation tests passed**. The backend and frontend were typechecked. These tests do not establish Arc-specific runtime behavior, a successful connected-wallet mainnet flow, a professional audit, or eligibility for a grant.

The AI response and metering are mocked, but local EIP-712 signing and contract transactions are real. There is no oracle proving that metered work occurred. Outstanding vouchers do not reserve funds: earlier settlements can exhaust available balance or lifetime capacity. Closing permits settlement strictly before `refundAvailableAt`; refund is allowed at or after it. Review signer trust, provider collection risk and the grace duration before handling real funds.

## Prepare the unsigned draft

Use Node.js **24+**, Bun **1.4.3**, Forge/Anvil, Solc **0.8.28** and OpenZeppelin **5.1.0**. Build artifacts must match the reviewed source; the current Foundry configuration uses Paris EVM and optimizer 200 runs.

```bash
bun run contracts:build
bun run contracts:test
bun run test
bun run test:backend
bun run typecheck
bun run e2e
bun run prepare:mainnet --out deployment-unsigned.json
```

The preparation helper combines **contract creation bytecode plus ABI-encoded constructor arguments**, checks compiler/source correspondence, and validates the decoded constructor. It writes an unsigned transaction draft with chain ID **5042** and official Arc USDC ERC-20 interface **`0x3600000000000000000000000000000000000000`**. It does not request a key, sign or broadcast.

The draft's default grace is **300 seconds**, intended only for the proposed Arc demo and still subject to review. `--grace SECONDS` can change the unsigned draft within the contract's bounds of 1 second to 30 days. The local backend remains **3,600 seconds**; generating the draft does not change it. No production grace recommendation has been approved.

The default command performs no RPC request. Optional `--from PUBLIC_ADDRESS --estimate` performs read-only Arc RPC checks and fee estimation; it still cannot sign or send. An estimate is not an approved final fee cap.

## Decisions required before broadcasting

1. Review the exact source, artifact, constructor USDC/grace, chain ID and unsigned creation data. Account for Arc's native-USDC gas and ERC-20 interface behavior; MockUSDC/standard Anvil does not reproduce it.
2. Complete final Studio synchronization/provenance review, signer/metering review and wallet-flow verification. Confirm any external program requirements separately.
3. Identify the user-controlled deployer, confirm funds and a fee cap, then obtain explicit approval for the exact transaction. The user must personally confirm any public wallet transaction; no deployment is authorized by this document.
4. After an approved deployment, verify source and constructor on the explorer, read `usdc()` and `GRACE_DURATION()`, record contract address/block/receipt, and only then configure `VITE_ESCROW_ADDRESS` using **`.env.example`** as the template.
5. Separately approve any small real-USDC lifecycle test and record its receipts. Deployment alone does not demonstrate a payment.

There is no proxy, administrator drain or emergency upgrade. A defective deployment requires a new instance and voluntary channel close/refund/migration. No independent professional audit has been performed.
