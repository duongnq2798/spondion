# Spondion Prepaid Escrow — Agent Memory

> Built with Arc Studio — https://studio.arc.io

## What this project is

Spondion is a prepaid USDC payment-channel escrow for metered AI/API payments,
built as a grant demo, now extended with a provider API workspace. It has three interfaces:

- **Merchant workspace** (default): React → Worker API → D1. ChatGPT platform identity isolates records. Sandbox searches Spondion documentation with zero charges. Optional `/v1` requires merchant credentials and live x402 exact/USDC/Base configuration. See `docs/MERCHANT-INTEGRATION.md`.

- **Demo mode** (`VITE_ENABLE_LOCAL_DEMO=true`): talks to a local Bun HTTP
  server that launches Anvil, deploys MockUSDC + SpondionPrepaidEscrow, and
  performs EIP-712 signing with fixture keys server-side.  No user wallet needed.

- **Arc wallet tab** (available in production): user connects their own wallet
  (Arc Mainnet chainId 5042, USDC 0x3600…0000).  Write actions are disabled
  until `VITE_ESCROW_ADDRESS` is set after mainnet approval.

## Contract Deployment Addresses

| Network | Address | Notes |
|---------|---------|-------|
| Anvil local (chainId 31337) | auto-deployed by `bun run server` | ephemeral |
| Arc Mainnet (chainId 5042) | _(not deployed)_ | pending approval |

## Key facts

- Contract: `contracts/SpondionPrepaidEscrow.sol` (non-upgradeable)
- Unit tests: 72 Foundry tests in `contracts/test/SpondionPrepaidEscrow.t.sol`
- All monetary amounts: decimal BigInt strings end-to-end [S10]
- ABI: object-format in `server/index.ts` (avoids abitype tuple limitation)
- Settlement history: rebuilt from on-chain `UsageSettled` logs [S6]
- AI response: simulated word-count output; EIP-712 signatures and Anvil transactions are real local tests.
- Final backend/frontend repairs were made locally after Studio's quota was exhausted. Contract source is unchanged from the Studio export; final Studio root synchronization remains pending.
- No independent professional audit performed

## Security constraints (server/index.ts)

| ID | Constraint |
|----|-----------|
| S1 | Binds to 127.0.0.1 only |
| S2 | Strict Origin check (allowlist: Vite dev + Studio preview) |
| S3 | assertLoopbackChain() before every sign/write/evm_ |
| S4 | Receipt status === "success" required |
| S5 | channelId decoded from ChannelOpened event (never nextChannelId-1) |
| S6 | Settlement history rebuilt from UsageSettled logs + block timestamps |
| S7 | Deadlines use block.timestamp, not Date.now() |
| S8 | skip-time uses chain time, not wall clock |
| S9 | Fixture keys server-side only |
| S10 | All amounts: decimal strings; no Number(bigint) |
| S11 | Leading-zero integers rejected (e.g. "01000" → 400) |

## Commands to run after changes

```bash
bun run contracts:build   # rebuild Solidity artifacts
bun run contracts:test    # 72+ unit tests
bun run typecheck         # frontend + backend
bun run test              # wallet validation
bun run test:backend      # backend regressions
bun run test:merchant     # durable core, SDK and Worker API checks
bun run e2e               # on-chain E2E (starts own Anvil + server)
bun run build:wallet      # production build (no demo tab)
```

## Do not do

- Do not deploy to any public network from Arc Studio.
- Do not add `VITE_ESCROW_ADDRESS` until the mainnet approval checklist is complete.
- Do not remove security constraints S1–S11.
- Do not convert bigint amounts to Number for monetary calculations.
- Do not include fixture keys in any frontend bundle.
