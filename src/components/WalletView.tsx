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
    <div className="space-y-5">

      {/* Unconfigured notice */}
      {!configured && (
        <div className="rounded-2xl bg-amber-50 border border-amber-200 p-5 space-y-2">
          <p className="text-sm font-semibold text-amber-800">Escrow not yet configured</p>
          <p className="text-xs text-amber-700">
            Set <code className="bg-amber-100 px-1 rounded">VITE_ESCROW_ADDRESS</code> after
            mainnet deployment.{" "}
            <code className="bg-amber-100 px-1 rounded">VITE_USDC_ADDRESS</code> defaults to the
            Arc Mainnet USDC address.
          </p>
          <p className="text-xs text-amber-600">
            Target chain: Arc Mainnet (chainId {CONFIGURED_CHAIN}).
            See <code>docs/mainnet-approval.md</code> before deploying.
          </p>
          <div className="rounded-lg bg-amber-100 border border-amber-200 p-3 text-xs font-mono space-y-0.5">
            <p><span className="text-amber-500">chain</span> {CONFIGURED_CHAIN}</p>
            <p><span className="text-amber-500">rpc</span> {ENV_RPC_URL}</p>
            <p><span className="text-amber-500">usdc</span> {ENV_USDC}</p>
            <p><span className="text-amber-500">escrow</span> <em className="text-amber-400">(not set)</em></p>
          </div>
        </div>
      )}

      {/* Wallet connect */}
      <div className="bg-white/70 rounded-2xl border border-slate-200/80 shadow-sm p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-800">Your Wallet (owner / signer)</p>
            {isConnected
              ? <p className="text-xs font-mono text-slate-500 mt-0.5">{address?.slice(0, 10)}…{address?.slice(-6)}</p>
              : <p className="text-xs text-slate-400 mt-0.5">Connect to interact with the escrow.</p>
            }
          </div>
          <ConnectKitButton />
        </div>

        {wrongNetwork && (
          <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 flex items-center justify-between gap-2">
            <p className="text-xs text-amber-700">
              Wrong network (connected: {chainId}, need: {targetChainId})
            </p>
            <button
              onClick={() => { if (targetChainId) switchChain({ chainId: targetChainId }); }}
              className="text-xs font-semibold text-amber-800 underline"
            >
              Switch
            </button>
          </div>
        )}

        {configured && isConnected && !wrongNetwork && (
          <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs font-mono space-y-0.5">
            <p><span className="text-slate-400">escrow</span> {escrowAddress}</p>
            <p><span className="text-slate-400">usdc</span> {usdcAddress}</p>
            {usdcDecimals !== null && (
              <p>
                <span className="text-slate-400">decimals</span> {usdcDecimals} (ERC-20)
                {tokenReady
                  ? <span className="text-emerald-600 ml-1">✓ escrow.usdc() matches</span>
                  : escrowUsdc
                    ? <span className="text-red-600 ml-1">✗ escrow.usdc()={escrowUsdc.slice(0, 10)}…</span>
                    : <span className="text-amber-500 ml-1">reading…</span>
                }
              </p>
            )}
          </div>
        )}
        {txHash && (
          <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs space-y-1">
            <p className="text-slate-700">{txStatus}</p>
            <a
              href={`https://explorer.arc.io/tx/${txHash}`}
              target="_blank" rel="noopener noreferrer"
              className="block font-mono text-blue-700 underline break-all"
            >
              {txHash}
            </a>
            <p className="text-slate-500">The latest transaction stays visible when you change or disconnect wallets.</p>
          </div>
        )}
      </div>

      {configured && (
        <>
          {/* ── Open Channel ── */}
          <SectionCard title="Open Channel">
            <p className="text-xs text-slate-500 mb-3">
              Your connected wallet is the <strong>owner</strong> and (by default) the
              authorized <strong>signer</strong>.  Enter the <strong>provider</strong> address
              (who provides the service and earns credit) and the <strong>payout</strong>
              address (where their credit is sent when they call withdraw()).
              Two separate accounts can interoperate: owner signs vouchers, provider settles them.
            </p>

            {/* Provider + Payout + Signer inputs */}
            <div className="space-y-2 mb-3">
              {([
                ["provider", "Provider address (0x…)", "Address that earns credit when vouchers are settled"],
                ["payout",   "Payout address (0x…)",   "Address that receives credit on withdraw()"],
                ["signer",   "Authorized signer (0x…, defaults to owner)", "Address whose EIP-712 signatures the contract will accept"],
              ] as [keyof typeof ocForm, string, string][]).map(([key, placeholder, hint]) => (
                <label key={key} className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-slate-400 capitalize">{key}</span>
                  <input
                    type="text"
                    className={`rounded-lg border px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400/50 ${
                      ocErrors[key] ? "border-red-400 bg-red-50" : "border-slate-200 bg-white"
                    }`}
                    placeholder={placeholder}
                    value={ocForm[key]}
                    onChange={(e) => { setOcForm((f) => ({ ...f, [key]: e.target.value.trim() })); setOcErrors((er) => ({ ...er, [key]: "" })); }}
                  />
                  {ocErrors[key]
                    ? <span className="text-[11px] text-red-600">{ocErrors[key]}</span>
                    : <span className="text-[11px] text-slate-400">{hint}</span>
                  }
                </label>
              ))}
            </div>

            {/* Caps */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              {([
                ["pricePerUnit", "Price/unit (µUSDC)"],
                ["perCallCap",   "Per-call cap (µ)"],
                ["lifetimeCap",  "Lifetime cap (µ)"],
              ] as [keyof typeof ocForm, string][]).map(([key, label]) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="text-[11px] text-slate-400">{label}</span>
                  <input
                    type="text" inputMode="numeric" pattern="\d*"
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-400/50"
                    value={ocForm[key]}
                    onChange={(e) => setOcForm((f) => ({ ...f, [key]: e.target.value.replace(/\D/g, "") }))}
                  />
                </label>
              ))}
            </div>

            <button
              onClick={handleOpenChannel}
              disabled={busy || !canOpen}
              className="w-full rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
            >
              {!isConnected ? "Connect wallet first" : !tokenReady ? "Inspecting token…" : "Open Channel"}
            </button>
          </SectionCard>

          {/* Channel ID + live state */}
          <div className="bg-white/70 rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500 font-medium">Channel ID</span>
              <input
                type="text" inputMode="numeric" pattern="\d*"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-400/50"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value.replace(/\D/g, ""))}
                placeholder="0"
              />
            </label>
            {channelInfo && (
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs font-mono space-y-0.5">
                <p><span className="text-slate-400">state</span> {channelInfo.state}</p>
                <p><span className="text-slate-400">owner</span> {channelInfo.owner}</p>
                <p><span className="text-slate-400">provider</span> {channelInfo.provider}</p>
                <p><span className="text-slate-400">payout</span> {channelInfo.payout}</p>
                <p><span className="text-slate-400">signer</span> {channelInfo.signer === "0x0000000000000000000000000000000000000000" ? "(owner)" : channelInfo.signer}</p>
                <p><span className="text-slate-400">balance</span> {microToDisplay(channelInfo.balance)} USDC</p>
                <p><span className="text-slate-400">spent</span> {microToDisplay(channelInfo.spent)} USDC</p>
                <p><span className="text-slate-400">cap</span> {microToDisplay(channelInfo.lifetimeCap)} USDC</p>
                {channelInfo.state === "Closing" && (
                  <p className="text-amber-600">
                    refund unlocks {new Date(Number(channelInfo.refundAvailableAt) * 1000).toLocaleTimeString()}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Approve + Deposit */}
          <SectionCard title="Approve + Deposit USDC">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500 font-medium">
                Amount (USDC, {usdcDecimals !== null ? `${usdcDecimals}-decimal ERC-20` : "loading…"})
              </span>
              <input
                type="text" inputMode="decimal"
                className={`rounded-lg border px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-400/50 ${
                  amountError ? "border-red-400 bg-red-50" : "border-slate-200 bg-white"
                }`}
                value={amount}
                onChange={(e) => handleAmountChange(e.target.value)}
              />
              {amountError
                ? <span className="text-[11px] text-red-600">{amountError}</span>
                : (
                  <span className="text-[11px] text-slate-400">
                    {safeBaseUnitsDisplay() ?? (usdcDecimals !== null && amount ? "invalid amount" : "")}
                  </span>
                )
              }
            </label>
            <button
              onClick={handleApproveAndDeposit}
              disabled={busy || !canDeposit || !!amountError}
              className="w-full mt-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
            >
              {!isConnected ? "Connect wallet first" : !tokenReady ? "Inspecting token…" : "Approve + Deposit (2 txs)"}
            </button>
          </SectionCard>

          {/* Sign + Settle + Export voucher */}
          <SectionCard title="Sign + Export Voucher (EIP-712, owner)">
            <p className="text-xs text-slate-500 mb-3">
              Signs a usage voucher as the channel owner. Export it as JSON and share
              with the provider for on-chain settlement, or settle directly below.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500 font-medium">Units to charge (integer string)</span>
              <input
                type="text" inputMode="numeric" pattern="\d*"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-400/50"
                value={units}
                onChange={(e) => setUnits(e.target.value.replace(/\D/g, "") || "1")}
              />
              {channelInfo && units && (
                <span className="text-[11px] text-slate-400">
                  Cost: {safeUsageCost()} USDC
                </span>
              )}
            </label>
            <button
              onClick={handleSignVoucher}
              disabled={busy || !canSign}
              className="w-full mt-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
            >
              Sign EIP-712 Voucher
            </button>
            {lastVoucher && (
              <div className="mt-3 rounded-xl bg-blue-50 border border-blue-100 p-3 text-xs space-y-1">
                <p className="font-semibold text-blue-700">Pending Voucher (signed, not yet settled)</p>
                <p className="font-mono text-blue-600 break-all">reqId: {lastVoucher.requestId.slice(0, 20)}…</p>
                <p className="text-blue-600">
                  {lastVoucher.units} unit(s) · expires{" "}
                  {new Date(Number(lastVoucher.deadline) * 1000).toLocaleTimeString()}
                </p>
                <button
                  onClick={exportVoucher}
                  className="mt-1 w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-1.5 transition-colors"
                >
                  Export Voucher JSON (share with provider)
                </button>
              </div>
            )}
          </SectionCard>

          {/* Import + Settle voucher — provider path */}
          <SectionCard title="Import + Settle Voucher (provider)">
            <p className="text-xs text-slate-500 mb-3">
              Provider: paste the JSON voucher received from the channel owner. Full
              schema validation runs before import — wrong chainId, escrow, requestId
              format, or oversized signature shows an error without touching valid state.
              Connect the channel's provider to settle a voucher authorized by its signer.
              The payout address withdraws the resulting credit.
            </p>
            <textarea
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-400/50 resize-none"
              rows={4}
              placeholder={'{"channelId":"0","requestId":"0x…","units":"5","deadline":"…","signature":"0x…","chainId":5042,"escrow":"0x…"}'}
              value={importJson}
              onChange={(e) => { setImportJson(e.target.value); setImportError(""); }}
            />
            {importError && (
              <p className="mt-1 text-xs text-red-600">{importError}</p>
            )}
            <div className="flex gap-2 mt-2">
              <button
                onClick={doImportVoucher}
                disabled={!importJson.trim()}
                className="flex-1 rounded-xl bg-slate-600 hover:bg-slate-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
              >
                Validate + Import
              </button>
              <button
                onClick={handleSettle}
                disabled={busy || !canSettle}
                className="flex-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
              >
                Settle On-chain
              </button>
            </div>
            {importedVoucher && (
              <div className="mt-2 rounded-xl bg-emerald-50 border border-emerald-100 p-3 text-xs space-y-0.5">
                <p className="font-semibold text-emerald-700">Imported Voucher (validated)</p>
                <p className="font-mono text-emerald-600">ch#{importedVoucher.channelId} · {importedVoucher.units} unit(s)</p>
                <p className="text-emerald-600 break-all">reqId: {importedVoucher.requestId.slice(0, 20)}…</p>
                <p className="text-emerald-500 text-[11px]">sig length: {(importedVoucher.signature.length - 2) / 2} bytes</p>
              </div>
            )}
          </SectionCard>

          {/* Close + Refund */}
          <SectionCard title="Close Channel">
            <div className="flex gap-2">
              <button
                onClick={handleRequestClose}
                disabled={busy || !canClose}
                className="flex-1 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
              >
                Request Close
              </button>
              <button
                onClick={handleFinalizeRefund}
                disabled={busy || !canRefund}
                className="flex-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
              >
                Finalize Refund
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              requestClose() starts the grace period on-chain.
              finalizeRefund() becomes available once the grace elapses.
            </p>
          </SectionCard>

          {/* Withdraw */}
          <SectionCard title="Withdraw Provider Credit">
            <p className="text-xs text-slate-500 mb-3">
              Calls <code>withdraw()</code> — your connected wallet must be the channel&apos;s
              payout address. The contract sends accumulated credit to <code>msg.sender</code>.
            </p>
            <button
              onClick={handleWithdraw}
              disabled={busy || !canWithdraw}
              className="w-full rounded-xl bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
            >
              Withdraw (wallet = payout address)
            </button>
          </SectionCard>
        </>
      )}

      {/* Arc Mainnet info */}
      {targetChainId === 5042 && (
        <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-slate-600 space-y-1">
          <p className="font-semibold">Arc Mainnet (chainId 5042)</p>
          <p>
            Gas token is USDC (18-decimal native view). This app uses the 6-decimal
            ERC-20 view exclusively — do not confuse the two.
          </p>
          <p className="text-amber-700 font-medium">
            Transactions involve real funds. Review <code>docs/mainnet-approval.md</code> before proceeding.
          </p>
        </div>
      )}

      {usdcDecimals !== null && (
        <p className="text-[11px] text-slate-400 text-center">
          Token: {usdcDecimals}-decimal ERC-20 · 1 USDC = 10<sup>{usdcDecimals}</sup> base units
        </p>
      )}
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/70 rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h2 className="font-semibold text-slate-800 text-sm uppercase tracking-wide" style={{ letterSpacing: "0.06em" }}>
          {title}
        </h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
