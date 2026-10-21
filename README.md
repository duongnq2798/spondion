# Spondion Prepaid Escrow

Spondion is a prepaid USDC escrow for metered AI/API requests. An owner funds a channel and signs EIP-712 usage vouchers; the designated provider settles them, and the channel's payout account withdraws its earned credit.

The demo's AI response and word-count metering are mocked. **Local EIP-712 signatures, contract execution and transaction receipts are real**, using publicly known fixture accounts on Anvil. No metering oracle verifies whether work was performed.

## Current status

- Independent local checks passed: **72 Solidity tests, 103 E2E assertions, 9 backend regressions and 25 wallet-validation tests**. The last group tests validation logic; it does not establish a connected-wallet mainnet flow.
- The contract source remains unchanged from the Studio export. Final frontend/backend repairs were made locally after Studio AI quota was exhausted; see [source provenance](docs/PROVENANCE.md) and [current evidence](docs/final-verification/). **Final Studio synchronization is pending.**
- Mainnet deployment, public-network wallet signing and real USDC payments have **not** been completed. No independent professional audit has been performed.
- Wallet mode defaults to Arc Mainnet, chain 5042. Leave `VITE_ESCROW_ADDRESS` blank until a deployment is approved and verified.

## Local setup

Install **Node.js 24 or newer**, **Bun 1.4.3**, and **Forge/Anvil** on PATH. Independent verification used Foundry 1.7.1, **Solc 0.8.28**, OpenZeppelin 5.1.0, viem 2.56.3, TypeScript 7.0.2 and Vite 6.0.5. The Foundry configuration uses Paris EVM, optimizer 200 runs. Standard Anvil tests use MockUSDC and do not reproduce Arc's native-USDC gas behavior.

Copy **`.env.example`** to `.env`; keep the escrow address empty. Do not commit `.env`.

```bash
npm install --legacy-peer-deps
bun run contracts:build
bun run contracts:test
bun run test
bun run test:backend
bun run typecheck
bun run e2e
bun run build
```

For the interactive local demo, run `bun run server` in one terminal and `bun run dev:demo` in another. The backend binds to `127.0.0.1:3001`, with Anvil on `127.0.0.1:8545`. Its channel grace period is **3,600 seconds**. The shipped E2E owns two separate loopback chains and cleans them up; `ANVIL_PORT`, `SERVER_ANVIL_PORT` and `API_PORT` must be distinct and free.

## Wallet configuration

| Variable | Default |
|---|---|
| `VITE_ENABLE_LOCAL_DEMO` | `false`; enable explicitly for the local demo |
| `VITE_CHAIN_ID` | `5042` |
| `VITE_RPC_URL` | `https://rpc.mainnet.arc.io` |
| `VITE_USDC_ADDRESS` | `0x3600000000000000000000000000000000000000` (ERC-20 interface, 6 decimals) |
| `VITE_ESCROW_ADDRESS` | Empty; writes remain disabled |

Production wallet mode uses the connected user's wallet and does not poll the fixture backend. Every amount remains a decimal string until exact bigint conversion. Backend JSON numbers are rejected before signing or writing; successful withdrawal responses derive their payout and amount from the receipt event.

## Trust and deployment review

Outstanding vouchers **do not reserve** channel balance or lifetime capacity. Competing valid vouchers share those limits, so the first valid settlement can consume funds needed by another voucher. In Closing state, settlement requires a timestamp strictly before `refundAvailableAt`; refund is allowed at or after that timestamp. The owner must trust the authorized signer and the provider's metering agreement.

Prepare the **unsigned 300-second Arc demo deployment draft** with:

```bash
bun run prepare:mainnet --out deployment-unsigned.json
```

This combines reviewed creation bytecode with the USDC address and constructor arguments, checks the source/compiler match, and writes unsigned data. It does not sign or broadcast. The **300-second draft** is a review choice; it does not change the local server's 3,600-second default or establish a production grace recommendation.

See [architecture](docs/architecture.md) and [mainnet review](docs/mainnet-approval.md) for the remaining decisions.
