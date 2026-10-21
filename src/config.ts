/**
 * wagmi configuration for Spondion
 *
 * Static Wallet mode targets Arc Mainnet (chainId 5042) with the official RPC.
 * The WagmiProvider must include Arc Mainnet so ConnectKit / wagmi chain-switching
 * works in the Wallet tab.  Ethereum mainnet is included only for ENS resolution.
 *
 * The local Anvil demo (chainId 31337) is NOT listed here — DemoView talks to
 * the backend API directly (no wagmi) so the Anvil chain does not need to appear
 * in the config.
 *
 * VITE_RPC_URL overrides the Arc transport. WalletView also validates the
 * target chain, USDC and escrow configuration before enabling actions.
 */

import { http, createConfig } from "wagmi";
import { mainnet } from "wagmi/chains";
import { defineChain } from "viem";
import { injected } from "wagmi/connectors";
import { registerChain } from "./tracing";

// ── Arc Mainnet (chainId 5042) ────────────────────────────────────────────────

export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18, // native gas view — 18 decimals (ERC-20 USDC view is 6)
  },
  rpcUrls: {
    default: { http: [String(import.meta.env.VITE_RPC_URL ?? "https://rpc.mainnet.arc.io").trim()] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});

// Pre-register chain RPC URL so trace events show correct chain name immediately
registerChain(arcMainnet.id, arcMainnet.rpcUrls.default.http[0]);

export const config = createConfig({
  chains: [arcMainnet, mainnet], // mainnet needed for ENS resolution only
  connectors: [injected()],
  transports: {
    [arcMainnet.id]: http(arcMainnet.rpcUrls.default.http[0]),
    [mainnet.id]:    http(), // ENS resolution
  },
});
