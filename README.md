# Spondion — API Payments Workspace

Spondion now includes a hosted merchant sandbox, durable search-operation records, result recovery and a TypeScript x402 integration. The public sandbox searches Spondion documentation, charges **0 USDC**, and saves private history after ChatGPT sign-in. It does not call a paid web-search API.

See [the SDK and API guide](docs/MERCHANT-INTEGRATION.md). The optional live route uses exact USDC payments on Base and stays disabled until a provider endpoint, recipient, price and facilitator credentials are configured. The Arc escrow is a separate interface and is not advertised as x402-compatible.

Spondion is a prepaid USDC escrow for metered AI/API requests. An owner funds a channel and signs EIP-712 usage vouchers; the designated provider settles them, and the channel's payout account withdraws its earned credit.

The demo's AI response and word-count metering are mocked. **Local EIP-712 signatures, contract execution and transaction receipts are real**, using publicly known fixture accounts on Anvil. No metering oracle verifies whether work was performed.

## Current status

- Independent local checks passed: **72 Solidity tests, 103 E2E assertions, 9 backend regressions and 25 wallet-validation tests**. The last group tests validation logic; it does not establish a connected-wallet mainnet flow.
- Merchant checks cover SQLite persistence, 100 concurrent duplicates, SDK-to-HTTP integration, response recovery, unknown settlement and owner isolation. See [release verification](docs/MERCHANT-RELEASE.md) for final results and limitations.
- The contract source remains unchanged from the Studio export. Final frontend/backend repairs were made locally after Studio AI quota was exhausted; see [source provenance](docs/PROVENANCE.md) and [current evidence](docs/final-verification/). **Final Studio synchronization is pending.**
- Mainnet deployment, public-network wallet signing and real USDC payments have **not** been completed. No independent professional audit has been performed.
- Wallet mode defaults to Arc Mainnet, chain 5042. Leave `VITE_ESCROW_ADDRESS` blank until a deployment is approved and verified.

## Local setup

Install **Node.js 24 or newer**, **Bun 1.4.3**, and **Forge/Anvil** on PATH. Solidity remains **0.8.28**, Paris EVM, optimizer 200, with OpenZeppelin **5.1.0**. The current lockfile uses x402 **2.28.0**, viem **2.57.5** and Vite **6.4.4**. Standard Anvil tests use MockUSDC and do not reproduce Arc's native-USDC gas behavior.

Copy **`.env.example`** to `.env`; keep the escrow address empty. Do not commit `.env`.

```bash
bun install --frozen-lockfile
bun run contracts:build
bun run contracts:test
bun run test
bun run test:merchant
bun run test:backend
bun run typecheck
bun run e2e
bun run build
```

For the hosted workspace preview, run `bunx wrangler d1 migrations apply DB --local` followed by `bun run dev:merchant`. Local sign-in is the Sites starter's loopback-only mock identity; production uses ChatGPT platform identity. Hosted D1 migrations are schema-only and the host provisions `DB`. Keep `.wrangler` and environment secrets out of source control.

`bun run build` creates a Worker in `dist/server` and browser assets in `dist/client`. A static-only deployment does not supply the new API or history. The previous static Site version remains a rollback option and does not delete D1 records.

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
