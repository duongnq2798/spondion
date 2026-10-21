# Spondion architecture

Spondion has two interfaces to the same non-upgradeable escrow contract:

| Mode | Execution and signing | Current scope |
|---|---|---|
| Local demo | React → Vite `/api` proxy → Bun backend → owned Anvil, MockUSDC and escrow | Real fixture EIP-712 signatures and transactions; mocked AI response/word-count metering |
| Wallet | React/wagmi/viem → connected wallet → configured chain and escrow | Arc Mainnet defaults; writes gated until a reviewed escrow address is configured |

Wallet mode does not poll the local backend. Fixture keys belong only in the local server/E2E code and must never enter browser bundles. Production Studio trace/console forwarding is guarded off; this does not claim all third-party wallet SDK analytics is disabled.

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

| Path | Purpose |
|---|---|
| `contracts/SpondionPrepaidEscrow.sol` | Studio-origin escrow source |
| `contracts/test/` | MockUSDC and Solidity regression/fuzz tests |
| `server/index.ts`, `server/backend-regression.test.ts` | Local fixture API and real HTTP-to-EVM regressions |
| `src/components/WalletView.tsx`, `src/lib/validation.ts` | Wallet flow and exact input/voucher validation |
| `scripts/e2e-onchain.ts` | Owned local-chain contract/API checks |
| `scripts/prepare-mainnet.ts` | Unsigned creation data with constructor/source checks |

Copy `.env.example` for local configuration. The unsigned Arc demo draft uses **300 seconds**, independently of the server's 3,600-second default. Neither is a reviewed production grace recommendation. No mainnet deployment or real USDC payment has been completed.
