/**
 * WalletView — EIP-1193 / viem wallet mode.
 *
 * Roles:
 *   owner   — the connected wallet; creates channels, approves + deposits, signs vouchers
 *   provider — an explicit address entered by the owner at channel-open time; receives credit
 *   payout   — an explicit address entered by the owner; where provider credit is sent
 *   signer   — optional; address whose signature the contract will accept (defaults to owner)
 *
 * Two developer accounts CAN interoperate:
 *   - Account A (owner)    connects, opens a channel with Account B as provider/payout,
 *     signs a voucher, exports JSON.
 *   - Account B (provider) connects, imports the JSON voucher, calls Settle On-chain.
 *     Because the escrow verifies the signer address stored in the channel, not msg.sender,
 *     only the channel's provider can settle, using a valid signature from its signer.
 *
 * Config comes from VITE_ env vars baked at build time:
 *   VITE_CHAIN_ID        — target chain (5042 for Arc Mainnet)
 *   VITE_RPC_URL         — public RPC endpoint
 *   VITE_USDC_ADDRESS    — USDC ERC-20 on that chain
 *   VITE_ESCROW_ADDRESS  — deployed SpondionPrepaidEscrow (empty = unconfigured)
 *
 * Arc note: chainId 5042, native gas IS USDC (18-decimal native view).
 * This app uses the 6-decimal ERC-20 view exclusively.
 *
 * Never auto-signs or auto-writes.  Every action verifies account+chain AFTER
 * any await (post-sign re-verification using operation generation).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  useAccount, useWalletClient, usePublicClient, useSwitchChain,
} from "wagmi";
import { ConnectKitButton } from "connectkit";
import { decodeEventLog } from "viem";
import { toast } from "sonner";
import { type Channel, microToDisplay } from "../types";
import { ESCROW_ABI, ERC20_ABI, VOUCHER_TYPES, VOUCHER_DOMAIN } from "../lib/escrowAbi";

// ── Build-time config (from VITE_ env vars) ───────────────────────────────────

const ENV_CHAIN_ID = import.meta.env["VITE_CHAIN_ID"]
  ? Number(String(import.meta.env["VITE_CHAIN_ID"]))
  : 5042; // Arc Mainnet default

const ENV_RPC_URL   = String(import.meta.env["VITE_RPC_URL"]         ?? "https://rpc.mainnet.arc.io").trim();
const ENV_ESCROW    = String(import.meta.env["VITE_ESCROW_ADDRESS"]  ?? "").trim();
const ENV_USDC      = String(import.meta.env["VITE_USDC_ADDRESS"]    ?? "0x3600000000000000000000000000000000000000").trim();

const CONFIGURED_ESCROW  = ENV_ESCROW as `0x${string}` | "";
const CONFIGURED_USDC    = ENV_USDC   as `0x${string}`;
const CONFIGURED_CHAIN   = ENV_CHAIN_ID > 0 ? ENV_CHAIN_ID : 5042;

import { parseUsdcStrict, parseUint256Strict, validateVoucher, VOUCHER_NAME, VOUCHER_VERSION, type ExportedVoucher } from "../lib/validation";

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomHex32(): `0x${string}` {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

// Validate an Ethereum address string
function isAddress(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(s) && s.toLowerCase() !== "0x0000000000000000000000000000000000000000";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function WalletView() {
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient }            = useWalletClient();
  const publicClient                      = usePublicClient();
  const { switchChain }                   = useSwitchChain();

  const escrowAddress = CONFIGURED_ESCROW || undefined;
  const usdcAddress   = CONFIGURED_USDC;
  const targetChainId = CONFIGURED_CHAIN;

  const configured   = !!escrowAddress && isAddress(escrowAddress)
    && escrowAddress.toLowerCase() !== "0x0000000000000000000000000000000000000000"
    && usdcAddress.toLowerCase() === "0x3600000000000000000000000000000000000000"
    && targetChainId === 5042;
  const wrongNetwork = isConnected && !!targetChainId && chainId !== targetChainId;
  const canWrite     = isConnected && configured && !wrongNetwork;

  // Token decimals — read once from chain when configured + connected
  const [usdcDecimals, setUsdcDecimals] = useState<number | null>(null);
  const [escrowUsdc,   setEscrowUsdc]   = useState<string>("");
  const [tokenReady,   setTokenReady]   = useState(false);

  const inspectToken = useCallback(async (): Promise<void> => {
    if (!publicClient || !usdcAddress || !escrowAddress) {
      setTokenReady(false); setUsdcDecimals(null); setEscrowUsdc(""); return;
    }
    try {
      const dec = await publicClient.readContract({
        address: usdcAddress, abi: ERC20_ABI, functionName: "decimals",
      });
      setUsdcDecimals(dec);
      const eu = await publicClient.readContract({
        address: escrowAddress, abi: ESCROW_ABI, functionName: "usdc",
      }).catch(() => "");
      setEscrowUsdc(eu as string);
      const match = dec === 6 && !!eu && (eu as string).toLowerCase() === usdcAddress.toLowerCase();
      setTokenReady(match);
      if (eu && !match) toast.warning("escrow.usdc() does not match VITE_USDC_ADDRESS — deposits disabled");
    } catch { setTokenReady(false); }
  }, [publicClient, usdcAddress, escrowAddress]);

  // ── Local UI state — declared BEFORE effects that reference these setters ──
  const [busy, setBusy]               = useState(false);
  const [channelId, setChannelId]     = useState("");
  const [amount, setAmount]           = useState("0.05");
  const [amountError, setAmountError] = useState<string>("");
  const [units, setUnits]             = useState("5");
  const [txHash, setTxHash]           = useState("");
  const [txStatus, setTxStatus]       = useState("");
  const [channelInfo, setChannelInfo] = useState<Channel | null>(null);
  const [lastVoucher, setLastVoucher] = useState<ExportedVoucher | null>(null);
  const [importedVoucher, setImportedVoucher] = useState<ExportedVoucher | null>(null);
  const [importJson, setImportJson]   = useState("");
  const [importError, setImportError] = useState<string>("");

  // openChannel role fields — explicit, no silent self-provider
  const [ocForm, setOcForm] = useState({
    pricePerUnit: "1000",
    perCallCap:   "10000",
    lifetimeCap:  "100000",
    provider:     "",   // must be explicitly entered
    payout:       "",   // must be explicitly entered
    signer:       "",   // defaults to connected owner but shown and editable
  });
  const [ocErrors, setOcErrors] = useState<Record<string, string>>({});

  // Token inspection effect
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void inspectToken(); }, [inspectToken]);

  // Operation generation: every new sign/write cycle gets a unique id.
  // After any await we re-read the current account and chain and compare.
  const opGenRef   = useRef(0);

  function newOpGen(): number {
    opGenRef.current += 1;
    return opGenRef.current;
  }

  // Re-check: called after any await inside an action.
  // Throws if account or chain changed since the action began.
  async function reVerify(label: string, gen: number, expectedAccount: string, expectedChain: number): Promise<void> {
    if (gen !== opGenRef.current) throw new Error(`${label}: a new operation started — aborting stale action`);
    if (!walletClient || !publicClient || !configured || !tokenReady) throw new Error(`${label}: wallet or USDC configuration is not ready`);
    // Check injected wallet's current accounts (not just wagmi's cached value)
    const accts = await walletClient.getAddresses();
    if (accts[0]?.toLowerCase() !== expectedAccount.toLowerCase()) {
      throw new Error(`${label}: account changed to ${accts[0]} — reconnect`);
    }
    // Check injected wallet's actual chain (not just RPC-configured chain)
    const wChain = await walletClient.getChainId();
    if (wChain !== expectedChain) {
      throw new Error(`${label}: chain changed to ${wChain} — need ${expectedChain}`);
    }
    if (await publicClient.getChainId() !== expectedChain) throw new Error(`${label}: RPC chain does not match the wallet`);
    if (gen !== opGenRef.current) throw new Error(`${label}: account or chain changed while checking`);
  }

  // Clear voucher state and channel info on account/chain changes
  const prevChainRef = useRef<number | undefined>(undefined);
  const prevAddrRef  = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prevChain = prevChainRef.current;
    const prevAddr  = prevAddrRef.current;
    prevChainRef.current = chainId;
    prevAddrRef.current  = address;
    if (
      (prevChain !== undefined && prevChain !== chainId) ||
      (prevAddr  !== undefined && prevAddr  !== address)
    ) {
      // Increment opGen so any in-flight action's post-await reVerify will fail
      opGenRef.current += 1;
      setLastVoucher(null);
      setChannelInfo(null);
      setImportedVoucher(null);
    }
  }, [chainId, address]);

  // Fill signer field with connected address when wallet connects and field is blank
  useEffect(() => {
    if (address && !ocForm.signer) {
      setOcForm((f) => ({ ...f, signer: address }));
    }
  }, [address]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-action guards
  const canDeposit  = canWrite && tokenReady && usdcDecimals !== null;
  const canSign     = canWrite && tokenReady;
  const canSettle   = canWrite && tokenReady && (!!lastVoucher || !!importedVoucher);
  const canClose    = canWrite && tokenReady;
  const canRefund   = canWrite && tokenReady;
  const canWithdraw = canWrite && tokenReady;
  const canOpen     = canWrite && tokenReady && usdcDecimals !== null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function withBusy(fn: () => Promise<void>): () => void {
    return () => {
      setBusy(true);
      fn()
        .catch((e: unknown) => { toast.error(e instanceof Error ? e.message : "Transaction error"); })
        .finally(() => setBusy(false));
    };
  }

  // A wallet change cancels later actions, never monitoring of a transaction
  // already broadcast. Keep its hash and use the original Arc RPC client.
  async function trackSubmittedTransaction(
    hash: `0x${string}`, label: string, client: NonNullable<typeof publicClient>,
  ) {
    setTxHash(hash);
    setTxStatus(`${label}: submitted on Arc Mainnet; awaiting confirmation`);
    const receipt = await client.waitForTransactionReceipt({ hash }).catch((error: unknown) => {
      setTxStatus(`${label}: submitted; confirmation unavailable — check the explorer`);
      throw new Error(`${label} was submitted as ${hash}. Confirmation is unavailable: ${error instanceof Error ? error.message : "RPC error"}`);
    });
    if (receipt.status !== "success") {
      setTxStatus(`${label}: reverted in block ${receipt.blockNumber}`);
      throw new Error(`${label} reverted. See transaction ${hash}`);
    }
    setTxStatus(`${label}: confirmed in block ${receipt.blockNumber}`);
    return receipt;
  }

  async function readChannelById(id: bigint): Promise<Channel | null> {
    if (!publicClient || !escrowAddress) return null;
    try {
      const raw = await publicClient.readContract({
        address: escrowAddress, abi: ESCROW_ABI, functionName: "getChannel", args: [id],
      }) as {
        owner: string; provider: string; payout: string; signer: string;
        pricePerUnit: bigint; perCallCap: bigint; lifetimeCap: bigint;
        balance: bigint; spent: bigint; refundAvailableAt: bigint; state: number;
      };
      const states = ["Active", "Closing", "Closed"] as const;
      return {
        channelId: id.toString(),
        owner: raw.owner, provider: raw.provider, payout: raw.payout, signer: raw.signer,
        pricePerUnit:      raw.pricePerUnit.toString(),
        perCallCap:        raw.perCallCap.toString(),
        lifetimeCap:       raw.lifetimeCap.toString(),
        balance:           raw.balance.toString(),
        spent:             raw.spent.toString(),
        refundAvailableAt: raw.refundAvailableAt.toString(),
        state: states[raw.state] ?? "Active",
      };
    } catch { return null; }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleOpenChannel = withBusy(async () => {
    if (!walletClient || !publicClient || !address || !escrowAddress || !usdcAddress || usdcDecimals === null) return;

    const gen = newOpGen();

    // Validate role addresses — explicit required, no silent self-provider
    const errors: Record<string, string> = {};
    if (!isAddress(ocForm.provider)) errors["provider"] = "Provider must be a valid 0x address";
    if (!isAddress(ocForm.payout))   errors["payout"]   = "Payout must be a valid 0x address";
    if (ocForm.payout.toLowerCase() === escrowAddress.toLowerCase()) errors["payout"] = "Payout cannot be the escrow contract";
    const signerAddr = ocForm.signer.trim() || address;
    if (!isAddress(signerAddr))      errors["signer"]   = "Signer must be a valid 0x address";
    if (Object.keys(errors).length > 0) { setOcErrors(errors); throw new Error("Fix address validation errors above"); }
    setOcErrors({});

    const pp = parseUint256Strict(ocForm.pricePerUnit, "Unit price", 1n);
    const pc = parseUint256Strict(ocForm.perCallCap, "Per-call cap", 1n);
    const lc = parseUint256Strict(ocForm.lifetimeCap, "Lifetime cap", 1n);
    if (pp > pc) throw new Error("Unit price must not exceed the per-call cap");
    if (pc > lc) throw new Error("perCallCap must be <= lifetimeCap");

    const zeroAddr = "0x0000000000000000000000000000000000000000" as const;
    const resolvedSigner = (signerAddr === address ? zeroAddr : signerAddr) as `0x${string}`;

    toast.info("Step 1/1: Opening channel…");

    // Pre-action check
    await reVerify("openChannel pre-check", gen, address, targetChainId);

    const openHash = await walletClient.writeContract({
      address: escrowAddress, abi: ESCROW_ABI, functionName: "openChannel",
      args: [ocForm.provider as `0x${string}`, ocForm.payout as `0x${string}`, resolvedSigner, pp, pc, lc],
    });

    const openReceipt = await trackSubmittedTransaction(openHash, "Open channel", publicClient);
    await reVerify("Open channel confirmed; follow-up check", gen, address, targetChainId);

    let newChannelId = "";
    for (const log of openReceipt.logs) {
      if (log.address.toLowerCase() !== escrowAddress.toLowerCase()) continue;
      try {
        const dec = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
        if (dec.eventName === "ChannelOpened") {
          newChannelId = (dec.args as { channelId: bigint }).channelId.toString();
          break;
        }
      } catch { /* skip */ }
    }
    if (!newChannelId) throw new Error("ChannelOpened event not found");

    setChannelId(newChannelId);
    toast.success(`Channel #${newChannelId} opened (tx ${openHash.slice(0, 10)}…)`);

    const ch = await readChannelById(BigInt(newChannelId));
    if (ch) setChannelInfo(ch);
  });

  const handleApproveAndDeposit = withBusy(async () => {
    if (!walletClient || !publicClient || !address || !escrowAddress || !usdcAddress || usdcDecimals === null) return;

    const gen = newOpGen();

    // Parse amount safely — no parseUnits on unvalidated input, no throwing in render
    const parsed = parseUsdcStrict(amount, usdcDecimals);
    if (!parsed.ok) throw new Error(`Invalid amount: ${parsed.error}`);
    const amtRaw = parsed.baseUnits;
    const id = parseUint256Strict(channelId, "Channel ID");
    const channel = await readChannelById(id);
    if (!channel || channel.owner.toLowerCase() !== address.toLowerCase() || channel.state !== "Active") {
      throw new Error("Connect the owner of an active channel before depositing");
    }

    toast.info("Step 1/2: Approving USDC…");
    await reVerify("approve pre-check", gen, address, targetChainId);

    const approveHash = await walletClient.writeContract({
      address: usdcAddress, abi: ERC20_ABI, functionName: "approve",
      args: [escrowAddress, amtRaw],
    });

    await trackSubmittedTransaction(approveHash, "USDC approval", publicClient);
    toast.success("Approved");

    // Approval is already sent; account changes stop the subsequent deposit.
    await reVerify("Approval confirmed; deposit pre-check", gen, address, targetChainId);

    toast.info("Step 2/2: Depositing…");
    const depositHash = await walletClient.writeContract({
      address: escrowAddress, abi: ESCROW_ABI, functionName: "deposit",
      args: [id, amtRaw],
    });

    const receipt = await trackSubmittedTransaction(depositHash, "USDC deposit", publicClient);
    await reVerify("Deposit confirmed; follow-up check", gen, address, targetChainId);
    toast.success(`Deposited ${amount} USDC — block ${receipt.blockNumber}`);

    const ch = await readChannelById(id);
    if (ch) setChannelInfo(ch);
  });

  const handleSignVoucher = withBusy(async () => {
    if (!walletClient || !publicClient || !escrowAddress || !targetChainId) return;
    if (!address) throw new Error("Wallet not connected");

    const gen = newOpGen();
    await reVerify("signVoucher pre-check", gen, address, targetChainId);

    const id = parseUint256Strict(channelId, "Channel ID");
    const ch = await readChannelById(id);
    if (!ch) { toast.error("Channel not found"); return; }
    if (ch.state !== "Active") { toast.error(`Channel is ${ch.state}`); return; }
    if (ch.signer.toLowerCase() !== address.toLowerCase()) {
      throw new Error("Connect this channel's authorized signer. Contract-wallet vouchers may also be signed externally and imported.");
    }
    setChannelInfo(ch);

    const unitsNum = parseUint256Strict(units, "Units", 1n);
    const cost = unitsNum * BigInt(ch.pricePerUnit);
    if (cost > BigInt(ch.perCallCap) || cost > BigInt(ch.balance) || cost + BigInt(ch.spent) > BigInt(ch.lifetimeCap)) {
      throw new Error("Usage exceeds this channel's balance or spending limits");
    }
    const requestId = randomHex32();
    const deadline = (await publicClient.getBlock()).timestamp + 300n;
    await reVerify("signVoucher ready", gen, address, targetChainId);

    toast.info("Sign the EIP-712 voucher in your wallet…");
    const signature = await walletClient.signTypedData({
      domain: { ...VOUCHER_DOMAIN, chainId: targetChainId, verifyingContract: escrowAddress },
      types: VOUCHER_TYPES,
      primaryType: "UsageVoucher",
      message: { channelId: id, requestId, units: unitsNum, deadline },
    });

    // Re-verify account+chain AFTER the await on signTypedData resolves
    // (user may have switched account while the sign dialog was open)
    await reVerify("signVoucher post-sign", gen, address, targetChainId);

    const valid = await publicClient.verifyTypedData({
      address: ch.signer as `0x${string}`,
      domain: { ...VOUCHER_DOMAIN, chainId: targetChainId, verifyingContract: escrowAddress },
      types: VOUCHER_TYPES,
      primaryType: "UsageVoucher",
      message: { channelId: id, requestId, units: unitsNum, deadline },
      signature,
    });
    await reVerify("signVoucher verified", gen, address, targetChainId);
    if (!valid) throw new Error("The channel signer did not authorize this voucher");

    const voucher: ExportedVoucher = {
      name: VOUCHER_NAME, version: VOUCHER_VERSION,
      channelId: id.toString(), requestId, units: unitsNum.toString(),
      deadline: deadline.toString(), signature, chainId: targetChainId, escrow: escrowAddress,
    };
    setLastVoucher(voucher);
    setImportedVoucher(null);
    setImportJson("");
    toast.success("Voucher signed — export JSON or settle directly");
  });

  const handleSettle = withBusy(async () => {
    const v = lastVoucher ?? importedVoucher;
    if (!walletClient || !publicClient || !escrowAddress || !v) return;
    if (!address) throw new Error("Wallet not connected");

    const gen = newOpGen();
    await reVerify("settle pre-check", gen, address, targetChainId);

    if (v.chainId !== targetChainId) throw new Error(`Voucher chain ${v.chainId} != ${targetChainId}`);
    if (v.escrow.toLowerCase() !== escrowAddress.toLowerCase()) throw new Error("Voucher escrow address mismatch");
    const channel = await readChannelById(BigInt(v.channelId));
    if (!channel || channel.provider.toLowerCase() !== address.toLowerCase()) throw new Error("Connect this channel's provider to settle usage");
    await reVerify("settle ready", gen, address, targetChainId);

    toast.info("Submitting settlement…");
    const hash = await walletClient.writeContract({
      address: escrowAddress, abi: ESCROW_ABI, functionName: "settleUsage",
      args: [BigInt(v.channelId), v.requestId, BigInt(v.units), BigInt(v.deadline), v.signature],
    });

    const receipt = await trackSubmittedTransaction(hash, "Usage settlement", publicClient);
    await reVerify("Settlement confirmed; follow-up check", gen, address, targetChainId);
    toast.success(`Settled — block ${receipt.blockNumber}`);
    setLastVoucher(null);
    setImportedVoucher(null);
    setImportJson("");

    const ch = await readChannelById(BigInt(v.channelId));
    if (ch) setChannelInfo(ch);
  });

  const handleRequestClose = withBusy(async () => {
    if (!walletClient || !publicClient || !escrowAddress) return;
    if (!address) throw new Error("Wallet not connected");
    const gen = newOpGen();
    await reVerify("requestClose pre-check", gen, address, targetChainId);
    const id = parseUint256Strict(channelId, "Channel ID");
    const hash = await walletClient.writeContract({
      address: escrowAddress, abi: ESCROW_ABI, functionName: "requestClose", args: [id],
    });
    await trackSubmittedTransaction(hash, "Request close", publicClient);
    await reVerify("Close confirmed; follow-up check", gen, address, targetChainId);
    toast.success("Close requested");
    const ch = await readChannelById(id);
    if (ch) setChannelInfo(ch);
  });

  const handleFinalizeRefund = withBusy(async () => {
    if (!walletClient || !publicClient || !escrowAddress) return;
    if (!address) throw new Error("Wallet not connected");
    const gen = newOpGen();
    await reVerify("finalizeRefund pre-check", gen, address, targetChainId);
    const id = parseUint256Strict(channelId, "Channel ID");
    const hash = await walletClient.writeContract({
      address: escrowAddress, abi: ESCROW_ABI, functionName: "finalizeRefund", args: [id],
    });
    await trackSubmittedTransaction(hash, "Unused balance refund", publicClient);
    await reVerify("Refund confirmed; follow-up check", gen, address, targetChainId);
    toast.success("Refund finalized");
    const ch = await readChannelById(id);
    if (ch) setChannelInfo(ch);
  });

  const handleWithdraw = withBusy(async () => {
    if (!walletClient || !publicClient || !escrowAddress) return;
    if (!address) throw new Error("Wallet not connected");
    const gen = newOpGen();
    await reVerify("withdraw pre-check", gen, address, targetChainId);
    const hash = await walletClient.writeContract({
      address: escrowAddress, abi: ESCROW_ABI, functionName: "withdraw", args: [],
    });
    await trackSubmittedTransaction(hash, "Provider withdrawal", publicClient);
    await reVerify("Withdrawal confirmed; follow-up check", gen, address, targetChainId);
    toast.success("Credit withdrawn to payout address (msg.sender)");
  });

  // ── Voucher export / import ────────────────────────────────────────────────

  function exportVoucher(): void {
    if (!lastVoucher) return;
    const blob = new Blob([JSON.stringify(lastVoucher, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `voucher-ch${lastVoucher.channelId}.json`; a.click();
    URL.revokeObjectURL(url);
    toast.success("Voucher exported — share with provider");
  }

  function doImportVoucher(): void {
    setImportError("");
    let raw: unknown;
    try { raw = JSON.parse(importJson); }
    catch { setImportError("Invalid JSON — cannot parse"); return; }

    if (!escrowAddress) { setImportError("Escrow not configured"); return; }
    const result = validateVoucher(raw, targetChainId, escrowAddress);
    if (!result.ok) {
      setImportError(result.error);
      return;  // do NOT alter importedVoucher on validation failure
    }
    setImportedVoucher(result.voucher);
    setLastVoucher(null);
    setImportError("");
    toast.success(`Voucher for channel #${result.voucher.channelId} imported`);
  }

  // Validate amount input without throwing
  function handleAmountChange(val: string): void {
    setAmount(val);
    if (!val.trim()) { setAmountError(""); return; }
    if (usdcDecimals === null) { setAmountError(""); return; }
    const r = parseUsdcStrict(val, usdcDecimals);
    setAmountError(r.ok ? "" : r.error);
  }

  // Safe base-unit preview (never throws in render)
  function safeBaseUnitsDisplay(): string | null {
    if (usdcDecimals === null || !amount.trim()) return null;
    const r = parseUsdcStrict(amount, usdcDecimals);
    if (!r.ok) return null;
    return r.display;
  }

  function safeUsageCost(): string {
    try {
      return channelInfo ? microToDisplay((parseUint256Strict(units, "Units", 1n) * BigInt(channelInfo.pricePerUnit)).toString()) : "—";
    } catch { return "Invalid units"; }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="wallet-workspace space-y-6 text-[#132c25]">
      <div className="wallet-overview grid gap-5 md:grid-cols-[1.35fr_1fr]">
        <section className="wallet-status-card wallet-connection-card rounded-2xl border border-[#dfe6e1] bg-white p-6 sm:p-7" aria-label="Your wallet">
          <div className="wallet-card-heading flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="wallet-icon flex h-11 w-11 items-center justify-center rounded-xl bg-[#edf5ee] text-[#17694d]" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v11H6a3 3 0 0 1-3-3V6" /><path d="M20 12h-5a2 2 0 0 0 0 4h5" /><path d="M16 14h.01" /></svg>
              </span>
              <div>
                <p className="wallet-eyebrow text-[11px] font-semibold uppercase tracking-[0.12em] text-[#77867d]">Payment wallet</p>
                <h2 className="mt-1 text-base font-semibold">Your funds. Your approval.</h2>
              </div>
            </div>
            <span className="wallet-network-badge inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#e0e8e1] px-2.5 py-1 text-[11px] font-medium text-[#52685a]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#17694d]" aria-hidden="true" /> Arc Mainnet
            </span>
          </div>

          <div className="mt-8 mb-6">
            <p className="wallet-eyebrow mb-2 text-xs text-[#77867d]">{isConnected ? "Connected account" : "Ready when you are"}</p>
            <p className={`text-2xl font-semibold tracking-[-0.035em] sm:text-[30px] ${isConnected ? "font-mono" : ""}`}>
              {isConnected ? `${address?.slice(0, 8)}…${address?.slice(-6)}` : "Connect your wallet"}
            </p>
            <p className="mt-2 max-w-md text-sm leading-6 text-[#77867d]">
              {isConnected ? "Review every authorization and payment from your own wallet." : "Manage prepaid USDC and authorize AI service usage in one place."}
            </p>
          </div>

          <div className="wallet-connect-row flex flex-wrap items-center justify-between gap-4 border-t border-[#edf0ed] pt-5">
            <div className="flex items-center gap-2 text-xs text-[#77867d]">
              <span className={`h-2 w-2 rounded-full ${isConnected ? "bg-[#17694d]" : "bg-[#c3cdc6]"}`} aria-hidden="true" />
              {isConnected ? "Wallet connected" : "No wallet connected"}
            </div>
            <div className="wallet-connect-button"><ConnectKitButton /></div>
          </div>

          {wrongNetwork && (
            <div className="wallet-note mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e4dcc5] bg-[#faf8f1] px-4 py-3 text-xs text-[#726344]" role="status">
              <span>Switch to Arc to continue with this wallet.</span>
              <button onClick={() => { if (targetChainId) switchChain({ chainId: targetChainId }); }} className="font-semibold text-[#17694d] underline underline-offset-4">Switch to Arc</button>
            </div>
          )}
        </section>

        <section className="wallet-status-card wallet-deployment-card flex flex-col rounded-2xl border border-[#dfe6e1] bg-white p-6 sm:p-7" aria-label="Payment availability">
          <div className="flex items-center justify-between gap-3">
            <p className="wallet-eyebrow text-[11px] font-semibold uppercase tracking-[0.12em] text-[#77867d]">Payment availability</p>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${configured && tokenReady ? "bg-[#edf5ee] text-[#17694d]" : "bg-[#f0f2ed] text-[#758069]"}`}>
              {!configured ? "Deployment pending" : tokenReady ? "USDC verified" : "Verification pending"}
            </span>
          </div>
          <h2 className="mt-6 max-w-[260px] text-[23px] font-semibold leading-[1.25] tracking-[-0.03em]">
            {!configured ? "Payments open after deployment." : "Your payment channel, on your terms."}
          </h2>
          <p className="mt-3 text-sm leading-6 text-[#77867d]">
            {!configured ? "Mainnet payments open after the escrow is deployed and approved. No funds are requested while deployment is pending." : "Set a budget, approve usage, and recover the balance you do not spend."}
          </p>
          <dl className="mt-auto space-y-3 pt-7 text-xs">
            <div className="flex justify-between gap-4 border-t border-[#edf0ed] pt-3"><dt className="text-[#77867d]">Settlement network</dt><dd className="font-medium">Arc Mainnet</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-[#77867d]">Payment asset</dt><dd className="font-medium">USDC</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-[#77867d]">Authorization</dt><dd className="font-medium">Your wallet, every action</dd></div>
          </dl>
          {configured && isConnected && !wrongNetwork && (
            <details className="wallet-contract-details mt-5 border-t border-[#edf0ed] pt-3 text-xs text-[#77867d]">
              <summary className="cursor-pointer font-medium text-[#52685a]">Contract details</summary>
              <dl className="mt-3 space-y-2 font-mono text-[11px]">
                <div><dt className="font-sans text-[#77867d]">Escrow</dt><dd className="mt-1 break-all text-[#52685a]">{escrowAddress}</dd></div>
                <div><dt className="font-sans text-[#77867d]">USDC</dt><dd className="mt-1 break-all text-[#52685a]">{usdcAddress}</dd></div>
                {usdcDecimals !== null && <div className="font-sans">{tokenReady ? "USDC token verified" : escrowUsdc ? "Token verification failed — payments are disabled" : "Verifying payment token…"}</div>}
              </dl>
            </details>
          )}
        </section>
      </div>

      {txHash && (
        <section className="wallet-transaction rounded-2xl border border-[#dfe6e1] bg-white px-5 py-4" aria-label="Latest transaction" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="wallet-eyebrow text-[11px] font-semibold uppercase tracking-[0.1em] text-[#77867d]">Latest transaction</p><p className="mt-1 text-sm font-medium">{txStatus}</p></div>
            <a href={`https://explorer.arc.io/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="wallet-explorer-link inline-flex items-center gap-2 text-xs font-semibold text-[#17694d]">View on explorer <span aria-hidden="true">↗</span></a>
          </div>
          <p className="mt-2 break-all font-mono text-[11px] text-[#77867d]">{txHash}</p>
          <p className="mt-2 text-[11px] text-[#77867d]">This transaction remains visible when you change or disconnect wallets.</p>
        </section>
      )}

      {!configured && (
        <section id="how-it-works" className="wallet-workflow rounded-2xl border border-[#dfe6e1] bg-white p-6 sm:p-7" aria-labelledby="wallet-workflow-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="wallet-eyebrow text-[11px] font-semibold uppercase tracking-[0.12em] text-[#77867d]">Built for the way agents work</p><h2 id="wallet-workflow-heading" className="mt-2 text-lg font-semibold tracking-[-0.02em]">A clear path from budget to usage.</h2></div>
            <span className="rounded-full bg-[#eff5e9] px-3 py-1.5 text-[11px] font-medium text-[#5f7650]">Prepaid. Usage-based. Refundable.</span>
          </div>
          <div className="mt-8 grid gap-7 sm:grid-cols-3 sm:gap-6">
            {([
              ["01", "Fund a channel", "Choose your provider, set a spending limit, and prepay only the USDC you want to use."],
              ["02", "Authorize usage", "Sign a usage voucher. Your provider can settle each authorized request only once."],
              ["03", "Refund what’s left", "Close the channel and recover unused funds after the settlement grace period."],
            ] as const).map(([number, title, description]) => (
              <div className="wallet-step" key={number}>
                <span className="wallet-step-number inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[#e0e9dc] bg-[#f4f8ef] text-xs font-semibold text-[#17694d]">{number}</span>
                <h3 className="mt-4 text-sm font-semibold">{title}</h3>
                <p className="mt-2 text-xs leading-[1.85] text-[#77867d]">{description}</p>
              </div>
            ))}
          </div>
          <div className="wallet-trust-note mt-7 flex items-center gap-2 border-t border-[#edf0ed] pt-4 text-[11px] text-[#77867d]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z" /><path d="m8 12 3 3 5-6" /></svg>
            Wallet approvals are always explicit. The current MVP has not been independently audited.
          </div>
        </section>
      )}

      {configured && (
        <div className="wallet-form-grid grid items-start gap-5 xl:grid-cols-2">
          <SectionCard title="Open a channel" eyebrow="Developer · Set your terms">
            <p className="wallet-note mb-5 text-xs leading-6 text-[#77867d]">Your wallet owns the channel. Choose the service provider, where earnings go, and who may authorize usage.</p>
            <div className="space-y-4">
              {([
                ["provider", "Service provider", "Wallet that settles authorized usage"],
                ["payout", "Earnings destination", "Wallet that withdraws provider earnings"],
                ["signer", "Authorized signer", "Defaults to your connected wallet"],
              ] as [keyof typeof ocForm, string, string][]).map(([key, label, hint]) => (
                <label key={key} className="wallet-field flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[#52685a]">{label}</span>
                  <input type="text" className={`wallet-input min-w-0 rounded-xl border bg-[#fcfdfb] px-3.5 py-3 font-mono text-xs outline-none focus:border-[#17694d] focus:ring-2 focus:ring-[#d8f3a3]/50 ${ocErrors[key] ? "border-red-400" : "border-[#dfe6e1]"}`} placeholder="0x…" value={ocForm[key]} onChange={(e) => { setOcForm((f) => ({ ...f, [key]: e.target.value.trim() })); setOcErrors((er) => ({ ...er, [key]: "" })); }} />
                  {ocErrors[key] ? <span className="text-[11px] text-red-600">{ocErrors[key]}</span> : <span className="text-[11px] text-[#8a968e]">{hint}</span>}
                </label>
              ))}
            </div>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {([
                ["pricePerUnit", "Price per unit"], ["perCallCap", "Per-request limit"], ["lifetimeCap", "Total usage limit"],
              ] as [keyof typeof ocForm, string][]).map(([key, label]) => (
                <label key={key} className="wallet-field flex min-w-0 flex-col gap-1.5"><span className="text-[11px] font-medium text-[#52685a]">{label}</span><input type="text" inputMode="numeric" pattern="\d*" className="wallet-input w-full min-w-0 rounded-xl border border-[#dfe6e1] bg-[#fcfdfb] px-3 py-3 text-sm tabular-nums outline-none focus:border-[#17694d] focus:ring-2 focus:ring-[#d8f3a3]/50" value={ocForm[key]} onChange={(e) => setOcForm((f) => ({ ...f, [key]: e.target.value.replace(/\D/g, "") }))} /></label>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-[#8a968e]">Limits use micro-USDC. 1 USDC = 1,000,000 micro-USDC.</p>
            <button onClick={handleOpenChannel} disabled={busy || !canOpen} className="wallet-button mt-5 w-full rounded-xl bg-[#17694d] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#12563f] disabled:cursor-not-allowed disabled:opacity-40">{!isConnected ? "Connect wallet first" : !tokenReady ? "Verifying token…" : "Create payment channel"}</button>
          </SectionCard>

          <SectionCard title="Fund your channel" eyebrow="Developer · Prepay in USDC">
            <p className="wallet-note mb-5 text-xs leading-6 text-[#77867d]">Add prepaid credit to an active channel. Your wallet confirms the exact allowance and deposit separately.</p>
            <label className="wallet-field flex flex-col gap-1.5"><span className="text-xs font-medium text-[#52685a]">Channel ID</span><input type="text" inputMode="numeric" pattern="\d*" className="wallet-input rounded-xl border border-[#dfe6e1] bg-[#fcfdfb] px-3.5 py-3 text-sm tabular-nums outline-none focus:border-[#17694d] focus:ring-2 focus:ring-[#d8f3a3]/50" value={channelId} onChange={(e) => setChannelId(e.target.value.replace(/\D/g, ""))} placeholder="Enter your channel ID" /></label>
            {channelInfo && (
              <div className="wallet-channel-summary my-5 rounded-xl border border-[#e1e9dd] bg-[#f6f9f2] p-4">
                <div className="mb-4 flex items-center justify-between gap-3"><span className="text-xs font-medium">Channel #{channelInfo.channelId}</span><span className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold text-[#17694d]">{channelInfo.state}</span></div>
                <dl className="grid grid-cols-3 gap-3"><div><dt className="text-[10px] text-[#77867d]">Available</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{microToDisplay(channelInfo.balance)} <span className="text-[10px] font-normal">USDC</span></dd></div><div><dt className="text-[10px] text-[#77867d]">Usage settled</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{microToDisplay(channelInfo.spent)} <span className="text-[10px] font-normal">USDC</span></dd></div><div><dt className="text-[10px] text-[#77867d]">Usage limit</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{microToDisplay(channelInfo.lifetimeCap)} <span className="text-[10px] font-normal">USDC</span></dd></div></dl>
                {channelInfo.state === "Closing" && <p className="mt-3 text-[11px] text-[#726344]">Refund available at {new Date(Number(channelInfo.refundAvailableAt) * 1000).toLocaleTimeString()}</p>}
                <details className="mt-4 border-t border-[#e1e9dd] pt-3 text-[11px] text-[#77867d]"><summary className="cursor-pointer font-medium">Channel participants</summary><dl className="mt-3 space-y-2 break-all"><div><dt>Owner</dt><dd className="font-mono text-[#52685a]">{channelInfo.owner}</dd></div><div><dt>Provider</dt><dd className="font-mono text-[#52685a]">{channelInfo.provider}</dd></div><div><dt>Payout</dt><dd className="font-mono text-[#52685a]">{channelInfo.payout}</dd></div><div><dt>Authorized signer</dt><dd className="font-mono text-[#52685a]">{channelInfo.signer === "0x0000000000000000000000000000000000000000" ? "Owner" : channelInfo.signer}</dd></div></dl></details>
              </div>
            )}
            <label className="wallet-field mt-5 flex flex-col gap-1.5"><span className="text-xs font-medium text-[#52685a]">Deposit amount</span><div className="relative"><input type="text" inputMode="decimal" className={`wallet-input w-full rounded-xl border bg-[#fcfdfb] px-3.5 py-3 pr-16 text-lg font-medium tabular-nums outline-none focus:border-[#17694d] focus:ring-2 focus:ring-[#d8f3a3]/50 ${amountError ? "border-red-400" : "border-[#dfe6e1]"}`} value={amount} onChange={(e) => handleAmountChange(e.target.value)} /><span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-medium text-[#77867d]">USDC</span></div>{amountError ? <span className="text-[11px] text-red-600">{amountError}</span> : <span className="text-[11px] text-[#8a968e]">{safeBaseUnitsDisplay() ?? (usdcDecimals !== null && amount ? "Invalid amount" : "")}</span>}</label>
            <button onClick={handleApproveAndDeposit} disabled={busy || !canDeposit || !!amountError} className="wallet-button mt-5 w-full rounded-xl bg-[#17694d] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#12563f] disabled:cursor-not-allowed disabled:opacity-40">{!isConnected ? "Connect wallet first" : !tokenReady ? "Verifying token…" : "Approve & deposit"}</button>
            <p className="mt-3 text-center text-[11px] text-[#8a968e]">Two wallet confirmations · Exact amount only</p>
          </SectionCard>

          <SectionCard title="Authorize usage" eyebrow="Authorized signer · Usage voucher">
            <p className="wallet-note mb-5 text-xs leading-6 text-[#77867d]">Approve a specific amount of service usage, then share the signed voucher with your provider.</p>
            <label className="wallet-field flex flex-col gap-1.5"><span className="text-xs font-medium text-[#52685a]">Usage units</span><input type="text" inputMode="numeric" pattern="\d*" className="wallet-input rounded-xl border border-[#dfe6e1] bg-[#fcfdfb] px-3.5 py-3 text-sm tabular-nums outline-none focus:border-[#17694d] focus:ring-2 focus:ring-[#d8f3a3]/50" value={units} onChange={(e) => setUnits(e.target.value.replace(/\D/g, "") || "1")} />{channelInfo && units && <span className="text-[11px] text-[#77867d]">Authorized cost: {safeUsageCost()} USDC</span>}</label>
            <button onClick={handleSignVoucher} disabled={busy || !canSign} className="wallet-button mt-5 w-full rounded-xl bg-[#17694d] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#12563f] disabled:cursor-not-allowed disabled:opacity-40">Sign usage voucher</button>
            {lastVoucher && <div className="mt-5 rounded-xl border border-[#dbe7d6] bg-[#f4f8ef] p-4 text-xs"><p className="font-semibold text-[#17694d]">Signed and ready to share</p><p className="mt-2 text-[#77867d]">{lastVoucher.units} units · Expires {new Date(Number(lastVoucher.deadline) * 1000).toLocaleTimeString()}</p><p className="mt-2 break-all font-mono text-[10px] text-[#8a968e]">{lastVoucher.requestId}</p><button onClick={exportVoucher} className="wallet-button-secondary mt-4 w-full rounded-xl border border-[#cddbc7] bg-white px-3 py-2.5 text-xs font-semibold text-[#17694d] hover:bg-[#edf5ee]">Download voucher JSON</button></div>}
          </SectionCard>

          <SectionCard title="Settle authorized usage" eyebrow="Service provider · Receive credit">
            <p className="wallet-note mb-5 text-xs leading-6 text-[#77867d]">Import the voucher shared by the authorized signer. Connect the channel’s provider wallet to settle it.</p>
            <label className="wallet-field flex flex-col gap-1.5"><span className="text-xs font-medium text-[#52685a]">Signed voucher</span><textarea className="wallet-input w-full resize-y rounded-xl border border-[#dfe6e1] bg-[#fcfdfb] px-3.5 py-3 font-mono text-xs outline-none focus:border-[#17694d] focus:ring-2 focus:ring-[#d8f3a3]/50" rows={5} placeholder="Paste the complete voucher JSON…" value={importJson} onChange={(e) => { setImportJson(e.target.value); setImportError(""); }} /></label>
            {importError && <p className="mt-2 text-[11px] text-red-600">{importError}</p>}
            <div className="mt-4 flex flex-wrap gap-3"><button onClick={doImportVoucher} disabled={!importJson.trim()} className="wallet-button-secondary flex-1 rounded-xl border border-[#d3ded4] bg-white px-4 py-3 text-xs font-semibold text-[#17694d] hover:bg-[#edf5ee] disabled:cursor-not-allowed disabled:opacity-40">Validate & import</button><button onClick={handleSettle} disabled={busy || !canSettle} className="wallet-button flex-1 rounded-xl bg-[#17694d] px-4 py-3 text-xs font-semibold text-white hover:bg-[#12563f] disabled:cursor-not-allowed disabled:opacity-40">Settle usage</button></div>
            {importedVoucher && <div className="mt-5 rounded-xl border border-[#dbe7d6] bg-[#f4f8ef] p-4 text-xs"><p className="font-semibold text-[#17694d]">Voucher loaded</p><p className="mt-2 text-[#77867d]">Channel #{importedVoucher.channelId} · {importedVoucher.units} units</p><p className="mt-2 break-all font-mono text-[10px] text-[#8a968e]">{importedVoucher.requestId}</p><p className="mt-2 text-[10px] text-[#8a968e]">Authorization is checked by the contract at settlement.</p></div>}
          </SectionCard>

          <SectionCard title="Recover unused funds" eyebrow="Developer · Close & refund">
            <p className="wallet-note mb-5 text-xs leading-6 text-[#77867d]">Close your channel to start the settlement grace period. When it ends, refund the remaining balance to your wallet.</p>
            <div className="flex flex-wrap gap-3"><button onClick={handleRequestClose} disabled={busy || !canClose} className="wallet-button-secondary flex-1 rounded-xl border border-[#d3ded4] bg-white px-4 py-3 text-xs font-semibold text-[#17694d] hover:bg-[#edf5ee] disabled:cursor-not-allowed disabled:opacity-40">Request close</button><button onClick={handleFinalizeRefund} disabled={busy || !canRefund} className="wallet-button flex-1 rounded-xl bg-[#17694d] px-4 py-3 text-xs font-semibold text-white hover:bg-[#12563f] disabled:cursor-not-allowed disabled:opacity-40">Refund balance</button></div>
          </SectionCard>

          <SectionCard title="Withdraw earnings" eyebrow="Payout wallet · Provider credit">
            <p className="wallet-note mb-5 text-xs leading-6 text-[#77867d]">Connect the channel’s earnings destination wallet to withdraw its accumulated USDC credit.</p>
            <button onClick={handleWithdraw} disabled={busy || !canWithdraw} className="wallet-button mt-auto w-full rounded-xl bg-[#17694d] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#12563f] disabled:cursor-not-allowed disabled:opacity-40">Withdraw provider credit</button>
          </SectionCard>
        </div>
      )}

      {configured && <div className="wallet-trust-note flex items-start gap-2 px-1 text-[11px] leading-5 text-[#8a968e]"><svg className="mt-0.5 shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4" /></svg><p>Arc Mainnet transactions use real USDC. Review every wallet confirmation. This MVP has not been independently audited.</p></div>}
    </div>
  );
}

function SectionCard({ title, eyebrow, children }: { title: string; eyebrow?: string; children: React.ReactNode }) {
  return (
    <section className="wallet-section-card min-w-0 overflow-hidden rounded-2xl border border-[#dfe6e1] bg-white">
      <header className="wallet-section-heading border-b border-[#edf0ed] px-6 py-5">
        {eyebrow && <p className="wallet-eyebrow mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#8a968e]">{eyebrow}</p>}
        <h2 className="text-base font-semibold tracking-[-0.02em] text-[#132c25]">{title}</h2>
      </header>
      <div className="wallet-section-body p-6">{children}</div>
    </section>
  );
}
