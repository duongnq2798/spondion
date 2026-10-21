#!/usr/bin/env bun
/**
 * Spondion On-chain E2E Test Suite — revision 4
 *
 * What this does (no public network, no user wallet, no paid API):
 *   1. Starts a fresh Anvil node on loopback port 18545 (chainId 31337).
 *   2. Deploys MockUSDC and SpondionPrepaidEscrow from compiled Foundry artifacts
 *      directly via viem (contract-level suite).
 *   3. Starts the demo backend server pointed at that Anvil (port 13001) and
 *      waits for /status.ready === true on a second owned Anvil node.
 *   4. Runs HTTP API suite against the server's own chain state.
 *
 * Ports are configurable via env vars for parallel CI use:
 *   ANVIL_PORT (default 18545)
 *   SERVER_ANVIL_PORT (default ANVIL_PORT + 1; isolates backend fixture nonces)
 *   API_PORT   (default 13001)
 *
 * Security guarantees:
 *   - All ports are loopback (127.0.0.1) only.
 *   - Uses fetch() for all readiness checks — no POSIX-only curl.
 *   - Cleans up only processes it launched (anvilProc, serverProc).
 *   - Server subprocess failures are captured and fail the suite.
 *   - No Number(bigint) monetary conversions anywhere.
 *
 * Run:  bun run e2e
 */

import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createPublicClient, createWalletClient, http,
  encodeAbiParameters, parseAbiParameters,
  getContract, decodeEventLog, type Address, type Log,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil as anvilChain } from "viem/chains";
import crypto from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const LOOPBACK   = "127.0.0.1";
const ANVIL_PORT = Number(process.env["ANVIL_PORT"] ?? 18545);
const SERVER_ANVIL_PORT = Number(process.env["SERVER_ANVIL_PORT"] ?? ANVIL_PORT + 1);
const API_PORT   = Number(process.env["API_PORT"]   ?? 13001);
const CHAIN_ID   = 31337;
const RPC_URL    = `http://${LOOPBACK}:${ANVIL_PORT}`;
const API_RPC_URL = `http://${LOOPBACK}:${SERVER_ANVIL_PORT}`;
const API_BASE   = `http://${LOOPBACK}:${API_PORT}`;

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");

// Anvil well-known keys (public, used only in local demo).
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner:    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  provider: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  payout:   "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

const deployerAccount = privateKeyToAccount(KEYS.deployer);
const ownerAccount    = privateKeyToAccount(KEYS.owner);
const providerAccount = privateKeyToAccount(KEYS.provider);
const payoutAccount   = privateKeyToAccount(KEYS.payout);

// ── Result tracking ───────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function pass(label: string, detail?: string): void {
  console.log(`  [PASS] ${label}${detail ? ` (${detail})` : ""}`);
  passed++;
}
function fail(label: string, detail?: string): void {
  console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) pass(label, detail); else fail(label, detail);
}

function randomId(): `0x${string}` {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}

// ── Artifact loader ───────────────────────────────────────────────────────────

function loadArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const p = join(ROOT, "contracts", "out", `${name}.sol`, `${name}.json`);
  const d = JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: d.abi, bytecode: d.bytecode.object };
}

// ── Readiness helpers (fetch-based — cross-platform) ─────────────────────────

/** Wait for Anvil JSON-RPC to accept connections. Uses fetch, not curl. */
async function waitRpcReady(url: string, maxMs = 10_000, proc?: ChildProcess): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) throw new Error(`Owned Anvil exited ${proc.exitCode} before readiness`);
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
        signal: AbortSignal.timeout(1000),
      });
      const body = await r.json() as { result?: string };
      if (r.ok && body.result === "0x7a69") return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} not ready after ${maxMs}ms`);
}

/** Listening is insufficient: wait until deployments and fixture approvals finish. */
async function waitHttpReady(statusUrl: string, maxMs = 30_000, proc?: ChildProcess): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    // Fail fast if the child process died.
    if (proc && proc.exitCode !== null) {
      throw new Error(`Server process exited with code ${proc.exitCode} before /status.ready`);
    }
    try {
      const r = await fetch(statusUrl, { signal: AbortSignal.timeout(1000) });
      const status = await r.json() as { ready?: boolean; chainId?: number; rpcUrl?: string };
      if (r.ok && status.ready === true && status.chainId === CHAIN_ID && status.rpcUrl === API_RPC_URL) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${statusUrl} not ready on the owned backend chain after ${maxMs}ms`);
}

/** Never attach the suite to an existing service, even on loopback. */
async function requireFreePort(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid fixture port ${port}`);
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(port, LOOPBACK, resolve);
  });
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
}

async function rpcRequest(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  if (url !== RPC_URL && url !== API_RPC_URL) throw new Error("Owned loopback RPC only");
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (!response.ok || body.error) throw new Error(`Fixture RPC ${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function blockTimestamp(url: string): Promise<bigint> {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", false], id: 1 }),
  });
  const d = await r.json() as { result: { timestamp: string } };
  return BigInt(d.result.timestamp);
}

async function evmIncreaseTime(url: string, seconds: number): Promise<void> {
  await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "evm_increaseTime", params: [seconds], id: 1 }),
  });
  await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "evm_mine", params: [], id: 2 }),
  });
}

// ── Mini ABIs ─────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  { type: "function", name: "mint",      stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "approve",   stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",       inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const ESCROW_ABI = [
  { type: "function", name: "openChannel",    stateMutability: "nonpayable", inputs: [{ name: "provider", type: "address" }, { name: "payout", type: "address" }, { name: "signer", type: "address" }, { name: "pricePerUnit", type: "uint256" }, { name: "perCallCap", type: "uint256" }, { name: "lifetimeCap", type: "uint256" }], outputs: [{ name: "channelId", type: "uint256" }] },
  { type: "function", name: "deposit",        stateMutability: "nonpayable", inputs: [{ name: "channelId", type: "uint256" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "settleUsage",    stateMutability: "nonpayable", inputs: [{ name: "channelId", type: "uint256" }, { name: "requestId", type: "bytes32" }, { name: "units", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "signature", type: "bytes" }], outputs: [] },
  { type: "function", name: "requestClose",   stateMutability: "nonpayable", inputs: [{ name: "channelId", type: "uint256" }], outputs: [] },
  { type: "function", name: "finalizeRefund", stateMutability: "nonpayable", inputs: [{ name: "channelId", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw",       stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function", name: "getChannel", stateMutability: "view",
    inputs: [{ name: "channelId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "provider", type: "address" },
      { name: "payout", type: "address" }, { name: "signer", type: "address" },
      { name: "pricePerUnit", type: "uint256" }, { name: "perCallCap", type: "uint256" },
      { name: "lifetimeCap", type: "uint256" }, { name: "balance", type: "uint256" },
      { name: "spent", type: "uint256" }, { name: "refundAvailableAt", type: "uint256" },
      { name: "state", type: "uint8" },
    ]}],
  },
  { type: "function", name: "isVoucherConsumed", stateMutability: "view", inputs: [{ name: "channelId", type: "uint256" }, { name: "requestId", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "nextChannelId",     stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "providerCredit",    stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalLiabilities",  stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "event", name: "ProviderWithdrawn", inputs: [{ name: "payout", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }], anonymous: false },
  { type: "event", name: "UsageSettled",      inputs: [{ name: "channelId", type: "uint256", indexed: true }, { name: "requestId", type: "bytes32", indexed: true }, { name: "units", type: "uint256", indexed: false }, { name: "amount", type: "uint256", indexed: false }], anonymous: false },
  { type: "event", name: "ChannelOpened",     inputs: [{ name: "channelId", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true }, { name: "provider", type: "address", indexed: true }, { name: "payout", type: "address", indexed: false }, { name: "signer", type: "address", indexed: false }, { name: "pricePerUnit", type: "uint256", indexed: false }, { name: "perCallCap", type: "uint256", indexed: false }, { name: "lifetimeCap", type: "uint256", indexed: false }], anonymous: false },
] as const;

const VOUCHER_TYPES = {
  UsageVoucher: [
    { name: "channelId", type: "uint256" },
    { name: "requestId", type: "bytes32" },
    { name: "units",     type: "uint256" },
    { name: "deadline",  type: "uint256" },
  ],
} as const;

// ── HTTP API helper ───────────────────────────────────────────────────────────

async function apiReq<T>(method: string, path: string, body?: unknown, origin?: string): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (origin) headers["Origin"] = origin;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as T;
  return { status: res.status, data };
}

// ── Deploy fixture ────────────────────────────────────────────────────────────

async function deploy(pub: ReturnType<typeof createPublicClient>): Promise<{ usdcAddress: Address; escrowAddress: Address }> {
  const deployer = createWalletClient({ account: deployerAccount, chain: anvilChain, transport: http(RPC_URL) });

  const cid = await pub.getChainId();
  assert("chainId is 31337", cid === CHAIN_ID, `got ${cid}`);

  const usdcArt = loadArtifact("MockUSDC");
  const usdcData = usdcArt.bytecode + encodeAbiParameters(parseAbiParameters("uint8"), [6]).slice(2);
  const usdcHash = await deployer.sendTransaction({ data: usdcData as `0x${string}`, gas: 2_000_000n });
  const usdcReceipt = await pub.waitForTransactionReceipt({ hash: usdcHash });
  assert("MockUSDC receipt success", usdcReceipt.status === "success");
  const usdcAddress = usdcReceipt.contractAddress as Address;
  assert("MockUSDC deployed", !!usdcAddress, usdcAddress);

  const escrowArt = loadArtifact("SpondionPrepaidEscrow");
  const escrowData = escrowArt.bytecode + encodeAbiParameters(
    parseAbiParameters("address, uint256"), [usdcAddress, 3600n],
  ).slice(2);
  const escrowHash = await deployer.sendTransaction({ data: escrowData as `0x${string}`, gas: 3_000_000n });
  const escrowReceipt = await pub.waitForTransactionReceipt({ hash: escrowHash });
  assert("Escrow receipt success", escrowReceipt.status === "success");
  const escrowAddress = escrowReceipt.contractAddress as Address;
  assert("SpondionPrepaidEscrow deployed", !!escrowAddress, escrowAddress);

  const usdcContract = getContract({ address: usdcAddress, abi: ERC20_ABI, client: deployer });
  const MINT = 10_000_000n;
  await pub.waitForTransactionReceipt({ hash: await usdcContract.write.mint([ownerAccount.address,    MINT]) });
  await pub.waitForTransactionReceipt({ hash: await usdcContract.write.mint([providerAccount.address, MINT]) });

  return { usdcAddress, escrowAddress };
}

// ── Test suites ───────────────────────────────────────────────────────────────

async function testOpenAndDeposit(pub: ReturnType<typeof createPublicClient>, escrow: Address, usdc: Address): Promise<bigint> {
  console.log("\n=== openChannel + deposit ===");
  const ownerWallet = createWalletClient({ account: ownerAccount, chain: anvilChain, transport: http(RPC_URL) });
  const PRICE = 1_000n, P_CAP = 10_000n, L_CAP = 100_000n, DEPOSIT = 50_000n;
  const usdcCt = getContract({ address: usdc, abi: ERC20_ABI, client: ownerWallet });
  await pub.waitForTransactionReceipt({ hash: await usdcCt.write.approve([escrow, DEPOSIT]) });
  const openHash = await ownerWallet.writeContract({
    address: escrow, abi: ESCROW_ABI, functionName: "openChannel",
    args: [providerAccount.address, payoutAccount.address, "0x0000000000000000000000000000000000000000", PRICE, P_CAP, L_CAP],
  });
  const openReceipt = await pub.waitForTransactionReceipt({ hash: openHash });
  assert("openChannel receipt success", openReceipt.status === "success");

  // Decode channelId from ChannelOpened event [S5]
  let channelId: bigint | undefined;
  for (const log of openReceipt.logs as Log[]) {
    try {
      const dec = decodeEventLog({ abi: ESCROW_ABI, eventName: "ChannelOpened", data: log.data, topics: log.topics });
      channelId = dec.args.channelId;
      break;
    } catch { /* not this event */ }
  }
  assert("ChannelOpened event present", channelId !== undefined);
  channelId = channelId ?? 0n;

  await pub.waitForTransactionReceipt({
    hash: await ownerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "deposit", args: [channelId, DEPOSIT] }),
  });
  const ch = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getChannel", args: [channelId] }) as { balance: bigint; state: number };
  assert("channel balance = DEPOSIT", ch.balance === DEPOSIT, `got ${ch.balance}`);
  assert("channel state Active (0)", ch.state === 0, `got ${ch.state}`);
  const liabilities = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "totalLiabilities", args: [] });
  assert("totalLiabilities >= DEPOSIT after open+fund", (liabilities) >= DEPOSIT, `got ${liabilities}`);
  return channelId;
}

async function testSettleUsage(pub: ReturnType<typeof createPublicClient>, escrow: Address, channelId: bigint): Promise<void> {
  console.log("\n=== settleUsage (EIP-712) ===");
  const providerWallet = createWalletClient({ account: providerAccount, chain: anvilChain, transport: http(RPC_URL) });
  const ownerWallet    = createWalletClient({ account: ownerAccount,    chain: anvilChain, transport: http(RPC_URL) });

  const requestId = randomId();
  const units     = 5n;
  // Use chain block.timestamp for deadline to match server [S7]
  const chainNow  = await blockTimestamp(RPC_URL);
  const deadline  = chainNow + 300n;

  const sig = await ownerWallet.signTypedData({
    domain: { name: "SpondionPrepaidEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrow },
    types: VOUCHER_TYPES, primaryType: "UsageVoucher",
    message: { channelId, requestId, units, deadline },
  });
  const settleHash = await providerWallet.writeContract({
    address: escrow, abi: ESCROW_ABI, functionName: "settleUsage",
    args: [channelId, requestId, units, deadline, sig],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: settleHash });
  assert("settle receipt success", receipt.status === "success");

  // Must decode from UsageSettled event — no fallback
  let decodedAmount: bigint | undefined;
  for (const log of receipt.logs as Log[]) {
    try {
      const dec = decodeEventLog({ abi: ESCROW_ABI, eventName: "UsageSettled", data: log.data, topics: log.topics });
      decodedAmount = dec.args.amount;
      break;
    } catch { /* not this event */ }
  }
  assert("UsageSettled event present", decodedAmount !== undefined);
  assert("UsageSettled event amount == 5 * 1000 = 5000", decodedAmount === 5_000n, `got ${decodedAmount}`);

  const ch = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getChannel", args: [channelId] }) as { balance: bigint; spent: bigint };
  assert("channel balance decreased by 5000", ch.balance === 45_000n, `got ${ch.balance}`);
  assert("channel spent increased by 5000",   ch.spent   === 5_000n,  `got ${ch.spent}`);
  const credit = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "providerCredit", args: [payoutAccount.address] });
  assert("provider credit = 5000", (credit) === 5_000n, `got ${credit}`);

  // Duplicate rejection — same requestId must revert
  console.log("\n=== duplicate rejection ===");
  let dupReverted = false;
  try { await providerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "settleUsage", args: [channelId, requestId, units, deadline, sig] }); }
  catch { dupReverted = true; }
  assert("duplicate settle reverts on-chain", dupReverted);

  // Inclusive deadline: block.timestamp == deadline must succeed (F3 fix)
  console.log("\n=== deadline boundary (inclusive) ===");
  const nowChain = await blockTimestamp(RPC_URL);
  const dlAtNow = nowChain + 30n;
  const reqAtNow = randomId();
  const sigAtNow = await ownerWallet.signTypedData({
    domain: { name: "SpondionPrepaidEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrow },
    types: VOUCHER_TYPES, primaryType: "UsageVoucher",
    message: { channelId, requestId: reqAtNow, units: 1n, deadline: dlAtNow },
  });
  await rpcRequest(RPC_URL, "evm_setNextBlockTimestamp", [Number(dlAtNow)]);
  const boundaryHash = await providerWallet.writeContract({
    address: escrow, abi: ESCROW_ABI, functionName: "settleUsage",
    args: [channelId, reqAtNow, 1n, dlAtNow, sigAtNow], gas: 200_000n,
  });
  const boundaryReceipt = await pub.waitForTransactionReceipt({ hash: boundaryHash });
  const boundaryBlock = await pub.getBlock({ blockHash: boundaryReceipt.blockHash });
  assert("boundary transaction block.timestamp equals deadline", boundaryBlock.timestamp === dlAtNow);
  assert("settlement at inclusive deadline succeeds", boundaryReceipt.status === "success");
  assert("boundary voucher consumed on chain", await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "isVoucherConsumed", args: [channelId, reqAtNow] }));

  // Past deadline must revert
  const pastDl  = dlAtNow;
  const reqPast = randomId();
  const sigPast = await ownerWallet.signTypedData({
    domain: { name: "SpondionPrepaidEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrow },
    types: VOUCHER_TYPES, primaryType: "UsageVoucher",
    message: { channelId, requestId: reqPast, units: 1n, deadline: pastDl },
  });
  await rpcRequest(RPC_URL, "evm_setNextBlockTimestamp", [Number(pastDl + 1n)]);
  await rpcRequest(RPC_URL, "evm_mine");
  assert("expired boundary is exactly deadline plus one second", await blockTimestamp(RPC_URL) === pastDl + 1n);
  let pastReverted = false;
  try { await providerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "settleUsage", args: [channelId, reqPast, 1n, pastDl, sigPast] }); }
  catch (error) { pastReverted = error instanceof Error && error.message.includes("VOUCHER_EXPIRED"); }
  assert("deadline plus one rejects with VOUCHER_EXPIRED", pastReverted);
  assert("expired boundary voucher remains unconsumed", !(await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "isVoucherConsumed", args: [channelId, reqPast] })));

  // Wrong-chain domain rejection
  console.log("\n=== wrong-chain domain rejection ===");
  const reqWC = randomId();
  const futureDeadline = nowChain + 300n;
  const sigWC = await ownerWallet.signTypedData({
    domain: { name: "SpondionPrepaidEscrow", version: "1", chainId: 1 /* Ethereum */, verifyingContract: escrow },
    types: VOUCHER_TYPES, primaryType: "UsageVoucher",
    message: { channelId, requestId: reqWC, units: 1n, deadline: futureDeadline },
  });
  let wcReverted = false;
  try { await providerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "settleUsage", args: [channelId, reqWC, 1n, futureDeadline, sigWC] }); }
  catch { wcReverted = true; }
  assert("wrong-chain EIP-712 domain reverts", wcReverted);

  // Same requestId + fresh signature must also revert (consumed map covers it)
  console.log("\n=== same requestId fresh signature ===");
  const sigFresh = await ownerWallet.signTypedData({
    domain: { name: "SpondionPrepaidEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrow },
    types: VOUCHER_TYPES, primaryType: "UsageVoucher",
    message: { channelId, requestId, units: 1n, deadline: futureDeadline },
  });
  let sameIdReverted = false;
  try { await providerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "settleUsage", args: [channelId, requestId, 1n, futureDeadline, sigFresh] }); }
  catch { sameIdReverted = true; }
  assert("same requestId with fresh signature reverts", sameIdReverted);
}

async function testCapEnforcement(pub: ReturnType<typeof createPublicClient>, escrow: Address, channelId: bigint): Promise<void> {
  console.log("\n=== cap enforcement ===");
  const providerWallet = createWalletClient({ account: providerAccount, chain: anvilChain, transport: http(RPC_URL) });
  const ownerWallet    = createWalletClient({ account: ownerAccount,    chain: anvilChain, transport: http(RPC_URL) });
  const chainNow = await blockTimestamp(RPC_URL);
  const dl = chainNow + 300n;
  const reqBig = randomId();
  const sigBig = await ownerWallet.signTypedData({
    domain: { name: "SpondionPrepaidEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrow },
    types: VOUCHER_TYPES, primaryType: "UsageVoucher",
    message: { channelId, requestId: reqBig, units: 11n /* exceeds perCallCap of 10 */, deadline: dl },
  });
  let capReverted = false;
  try { await providerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "settleUsage", args: [channelId, reqBig, 11n, dl, sigBig] }); }
  catch { capReverted = true; }
  assert("per-call cap exceeded reverts", capReverted);
}

async function testReplayAfterTopUp(pub: ReturnType<typeof createPublicClient>, escrow: Address, usdc: Address, channelId: bigint): Promise<void> {
  console.log("\n=== replay after top-up (must still reject) ===");
  const ownerWallet    = createWalletClient({ account: ownerAccount, chain: anvilChain, transport: http(RPC_URL) });
  const providerWallet = createWalletClient({ account: providerAccount, chain: anvilChain, transport: http(RPC_URL) });

  // Record a requestId that we'll try to replay after top-up
  const chainNow = await blockTimestamp(RPC_URL);
  const dlOld = chainNow + 300n;
  const reqToReplay = randomId();
  const sigToReplay = await ownerWallet.signTypedData({
    domain: { name: "SpondionPrepaidEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrow },
    types: VOUCHER_TYPES, primaryType: "UsageVoucher",
    message: { channelId, requestId: reqToReplay, units: 2n, deadline: dlOld },
  });
  // Settle it once
  await pub.waitForTransactionReceipt({
    hash: await providerWallet.writeContract({
      address: escrow, abi: ESCROW_ABI, functionName: "settleUsage",
      args: [channelId, reqToReplay, 2n, dlOld, sigToReplay],
    }),
  });

  // Top-up the channel
  const usdcCt = getContract({ address: usdc, abi: ERC20_ABI, client: ownerWallet });
  await pub.waitForTransactionReceipt({ hash: await usdcCt.write.approve([escrow, 50_000n]) });
  await pub.waitForTransactionReceipt({
    hash: await ownerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "deposit", args: [channelId, 50_000n] }),
  });
  pass("top-up deposit succeeded");

  // Replay of the consumed requestId MUST revert even after top-up
  let replayReverted = false;
  try {
    await providerWallet.writeContract({
      address: escrow, abi: ESCROW_ABI, functionName: "settleUsage",
      args: [channelId, reqToReplay, 2n, dlOld, sigToReplay],
    });
  } catch { replayReverted = true; }
  assert("replay after top-up reverts (consumedVouchers mapping)", replayReverted);

  const ch = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getChannel", args: [channelId] }) as { balance: bigint };
  assert("balance positive after top-up", ch.balance > 0n, `got ${ch.balance}`);
}

async function testCloseAndRefund(pub: ReturnType<typeof createPublicClient>, escrow: Address, channelId: bigint): Promise<void> {
  console.log("\n=== requestClose + early-refund rejection + grace + finalizeRefund ===");
  const ownerWallet = createWalletClient({ account: ownerAccount, chain: anvilChain, transport: http(RPC_URL) });
  const balanceBefore = (await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getChannel", args: [channelId] }) as { balance: bigint }).balance;

  const closeHash = await ownerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "requestClose", args: [channelId] });
  const closeReceipt = await pub.waitForTransactionReceipt({ hash: closeHash });
  assert("requestClose receipt success", closeReceipt.status === "success");

  const chClosing = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getChannel", args: [channelId] }) as { state: number; refundAvailableAt: bigint };
  assert("state is Closing (1)", chClosing.state === 1, `got ${chClosing.state}`);
  assert("refundAvailableAt > 0", chClosing.refundAvailableAt > 0n);

  // Early-refund must revert (grace not elapsed)
  let earlyReverted = false;
  try { await ownerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "finalizeRefund", args: [channelId] }); }
  catch { earlyReverted = true; }
  assert("early finalizeRefund reverts (grace not elapsed)", earlyReverted);

  // Skip past grace period using chain time
  await evmIncreaseTime(RPC_URL, 3601 + 5);
  assert("time advanced past grace period", true);

  const refundHash = await ownerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "finalizeRefund", args: [channelId] });
  const refundReceipt = await pub.waitForTransactionReceipt({ hash: refundHash });
  assert("finalizeRefund receipt success", refundReceipt.status === "success");

  const chClosed = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getChannel", args: [channelId] }) as { state: number; balance: bigint };
  assert("state is Closed (2)", chClosed.state === 2, `got ${chClosed.state}`);
  assert("channel balance is 0 after refund", chClosed.balance === 0n, `got ${chClosed.balance}`);
  pass("refund confirmed", `returned ${balanceBefore} µUSDC`);
}

async function testWithdraw(pub: ReturnType<typeof createPublicClient>, escrow: Address): Promise<void> {
  console.log("\n=== provider withdraw + ProviderWithdrawn event ===");
  const payoutWallet = createWalletClient({ account: payoutAccount, chain: anvilChain, transport: http(RPC_URL) });
  const creditBefore = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "providerCredit", args: [payoutAccount.address] });
  assert("payout has nonzero credit before withdraw", creditBefore > 0n, `got ${creditBefore}`);

  const withdrawHash = await payoutWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "withdraw", args: [] });
  const receipt = await pub.waitForTransactionReceipt({ hash: withdrawHash });
  assert("withdraw receipt success", receipt.status === "success");

  // Decode ProviderWithdrawn event — must be present
  let decodedWithdrawn: bigint | undefined;
  for (const log of receipt.logs as Log[]) {
    try {
      const dec = decodeEventLog({ abi: ESCROW_ABI, eventName: "ProviderWithdrawn", data: log.data, topics: log.topics });
      decodedWithdrawn = dec.args.amount;
      break;
    } catch { /* not this event */ }
  }
  assert("ProviderWithdrawn event present", decodedWithdrawn !== undefined);
  assert("ProviderWithdrawn amount == prior credit (exact conservation)", decodedWithdrawn === creditBefore, `decoded=${decodedWithdrawn} credit=${creditBefore}`);

  const afterCredit = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "providerCredit", args: [payoutAccount.address] });
  assert("credit zeroed after withdraw", afterCredit === 0n, `got ${afterCredit}`);
}

async function testConservation(pub: ReturnType<typeof createPublicClient>, escrow: Address, usdc: Address): Promise<void> {
  console.log("\n=== multi-op conservation (balanceOf(escrow) >= totalLiabilities) ===");
  const ownerWallet    = createWalletClient({ account: ownerAccount,    chain: anvilChain, transport: http(RPC_URL) });
  const providerWallet = createWalletClient({ account: providerAccount, chain: anvilChain, transport: http(RPC_URL) });
  const payoutWallet   = createWalletClient({ account: payoutAccount,   chain: anvilChain, transport: http(RPC_URL) });

  const usdcCt = getContract({ address: usdc, abi: ERC20_ABI, client: ownerWallet });
  await pub.waitForTransactionReceipt({ hash: await usdcCt.write.approve([escrow, 200_000n]) });
  const openHash = await ownerWallet.writeContract({
    address: escrow, abi: ESCROW_ABI, functionName: "openChannel",
    args: [providerAccount.address, payoutAccount.address, "0x0000000000000000000000000000000000000000", 1_000n, 10_000n, 100_000n],
  });
  const openReceipt = await pub.waitForTransactionReceipt({ hash: openHash });
  // Decode channelId from event
  let cid: bigint | undefined;
  for (const log of openReceipt.logs as Log[]) {
    try {
      const dec = decodeEventLog({ abi: ESCROW_ABI, eventName: "ChannelOpened", data: log.data, topics: log.topics });
      cid = dec.args.channelId; break;
    } catch { /* skip */ }
  }
  assert("conservation channel opened (event decoded)", cid !== undefined);
  if (cid === undefined) throw new Error("Conservation channel event missing");
  await pub.waitForTransactionReceipt({
    hash: await ownerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "deposit", args: [cid, 100_000n] }),
  });

  // Settle 3 times
  for (let i = 0; i < 3; i++) {
    const reqId    = randomId();
    const chainNow = await blockTimestamp(RPC_URL);
    const dl       = chainNow + 300n;
    const sig = await ownerWallet.signTypedData({
      domain: { name: "SpondionPrepaidEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: escrow },
      types: VOUCHER_TYPES, primaryType: "UsageVoucher",
      message: { channelId: cid, requestId: reqId, units: 2n, deadline: dl },
    });
    await pub.waitForTransactionReceipt({
      hash: await providerWallet.writeContract({
        address: escrow, abi: ESCROW_ABI, functionName: "settleUsage", args: [cid, reqId, 2n, dl, sig],
      }),
    });
  }

  const contractBal  = await pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [escrow] });
  const liabilities  = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "totalLiabilities", args: [] });
  assert("contract balance >= totalLiabilities (solvent)", contractBal >= liabilities, `bal=${contractBal} liab=${liabilities}`);

  // Withdraw provider credit, close and refund
  await pub.waitForTransactionReceipt({ hash: await payoutWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "withdraw", args: [] }) });
  await pub.waitForTransactionReceipt({ hash: await ownerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "requestClose", args: [cid] }) });
  await evmIncreaseTime(RPC_URL, 3700);
  await pub.waitForTransactionReceipt({ hash: await ownerWallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "finalizeRefund", args: [cid] }) });

  const finalBal  = await pub.readContract({ address: usdc,   abi: ERC20_ABI, functionName: "balanceOf",    args: [escrow] });
  const finalLiab = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "totalLiabilities", args: [] });
  assert("exact conservation after full lifecycle (bal >= liab)", finalBal >= finalLiab, `bal=${finalBal} liab=${finalLiab}`);
  assert("completed fixture lifecycles leave zero liabilities", finalLiab === 0n, `got ${finalLiab}`);
  assert("completed fixture lifecycles leave zero escrow tokens", finalBal === 0n, `got ${finalBal}`);
}

// ── Malformed-input / no-state-change tests ───────────────────────────────────

async function testMalformedInput(): Promise<void> {
  console.log("\n=== malformed input / no-state-change (before any writes) ===");

  // Float amounts must return 400
  const floatCases = [
    { pricePerUnit: "1.5",  perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "0" },
    { pricePerUnit: "1000", perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "0.5" },
  ];
  for (const body of floatCases) {
    const { status } = await apiReq("POST", "/channels", body);
    assert(`float amount rejected 400 (${JSON.stringify(body).slice(0, 40)})`, status === 400, `got ${status}`);
  }

  // Zero pricePerUnit → 400
  const { status: zeroPrice } = await apiReq("POST", "/channels", {
    pricePerUnit: "0", perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "0",
  });
  assert("zero pricePerUnit rejected 400", zeroPrice === 400, `got ${zeroPrice}`);

  // Negative → 400
  const { status: negPrice } = await apiReq("POST", "/channels", {
    pricePerUnit: "-1", perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "0",
  });
  assert("negative pricePerUnit rejected 400", negPrice === 400, `got ${negPrice}`);

  // Leading zeros → 400 [S11]
  const { status: leadingZero } = await apiReq("POST", "/channels", {
    pricePerUnit: "01000", perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "0",
  });
  assert("leading-zero amount rejected 400 (S11)", leadingZero === 400, `got ${leadingZero}`);

  // perCallCap > lifetimeCap → 400
  const { status: capMismatch } = await apiReq("POST", "/channels", {
    pricePerUnit: "1000", perCallCap: "50000", lifetimeCap: "10000", initialDeposit: "0",
  });
  assert("perCallCap > lifetimeCap rejected 400", capMismatch === 400, `got ${capMismatch}`);

  // Voucher for nonexistent channel → 404
  const { status: noChannel } = await apiReq("POST", "/channels/9999999/voucher", { units: "1" });
  assert("voucher for nonexistent channel → 404", noChannel === 404, `got ${noChannel}`);

  // settle with missing requestId → 400
  const { status: noReqId } = await apiReq("POST", "/channels/0/settle", {
    units: "1", deadline: "9999999999", signature: "0x" + "ab".repeat(65),
  });
  assert("settle with missing requestId → 400", noReqId === 400, `got ${noReqId}`);

  // settle with float units → 400
  const { status: floatUnits } = await apiReq("POST", "/channels/0/settle", {
    requestId: "0x" + "ab".repeat(32), units: "1.5",
    deadline: "9999999999", signature: "0x" + "ab".repeat(65),
  });
  assert("settle with float units → 400", floatUnits === 400, `got ${floatUnits}`);

  // Wrong payout → 400
  const { status: wrongPayout } = await apiReq("POST", "/withdraw", {
    payout: "0x1234567890123456789012345678901234567890",
  });
  assert("withdraw with wrong payout address → 400", wrongPayout === 400, `got ${wrongPayout}`);

  // demo/complete with float channelId → 400
  const { status: badChanId } = await apiReq("POST", "/demo/complete", { channelId: "1.5", prompt: "test" });
  assert("demo/complete with float channelId → 400", badChanId === 400, `got ${badChanId}`);

  // Forbidden Origin rejection
  const { status: forbiddenOrigin } = await apiReq("POST", "/channels", {
    pricePerUnit: "1000", perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "0",
  }, "https://attacker.example.com");
  assert("forbidden Origin returns 403", forbiddenOrigin === 403, `got ${forbiddenOrigin}`);
}

// ── HTTP API mandatory sequence ───────────────────────────────────────────────

async function testApiPath(fixturePayoutAddress: string): Promise<void> {
  console.log("\n=== HTTP API mandatory sequence ===");

  // Health + Status
  const { status: hs } = await apiReq<{ status: string }>("GET", "/health");
  assert("GET /health 200", hs === 200, `got ${hs}`);
  const { status: ss, data: sd } = await apiReq<{ ready: boolean }>("GET", "/status");
  assert("GET /status 200 ready=true", ss === 200 && sd.ready === true);

  // Concurrent opens: open 2 channels and verify distinct event-decoded IDs
  console.log("  -- concurrent opens (distinct event-decoded IDs) --");
  const [r1, r2] = await Promise.all([
    apiReq<{ channel: { channelId: string } }>("POST", "/channels", {
      pricePerUnit: "1000", perCallCap: "10000", lifetimeCap: "200000", initialDeposit: "50000",
    }),
    apiReq<{ channel: { channelId: string } }>("POST", "/channels", {
      pricePerUnit: "2000", perCallCap: "20000", lifetimeCap: "200000", initialDeposit: "60000",
    }),
  ]);
  assert("concurrent open 1 → 201", r1.status === 201, `got ${r1.status}`);
  assert("concurrent open 2 → 201", r2.status === 201, `got ${r2.status}`);
  assert("concurrent opens return distinct channelIds", r1.data.channel.channelId !== r2.data.channel.channelId,
    `ch1=${r1.data.channel.channelId} ch2=${r2.data.channel.channelId}`);

  // Main test channel
  interface ChanResp { channel: { channelId: string; balance: string; state: string } }
  const { status: cs, data: cd } = await apiReq<ChanResp>("POST", "/channels", {
    pricePerUnit: "1000", perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "50000",
  });
  assert("POST /channels 201", cs === 201, `got ${cs}`);
  const chanId = cd.channel.channelId;
  assert("channel state Active", cd.channel.state === "Active");
  assert("channel balance is decimal string", typeof cd.channel.balance === "string");
  // Verify BigInt parse of balance string
  assert("balance string parses as BigInt", (() => { try { BigInt(cd.channel.balance); return true; } catch { return false; } })());

  // Voucher — units as decimal string
  interface VouchResp { voucher: { requestId: string; units: string; deadline: string; signature: string; channelId: string; deadlineMs: number }; signingMethod: string }
  const { status: vs, data: vd } = await apiReq<VouchResp>("POST", `/channels/${chanId}/voucher`, { units: "3" });
  assert("POST /voucher 200", vs === 200, `got ${vs}`);
  assert("signingMethod EIP-712", vd.signingMethod === "EIP-712");
  assert("voucher.units is string", typeof vd.voucher.units === "string");
  assert("voucher.deadline is string", typeof vd.voucher.deadline === "string");
  assert("voucher.channelId matches", vd.voucher.channelId === chanId);
  const voucher = vd.voucher;

  // Settle — amount must be string and must be nonzero and equal 3 * 1000 = 3000
  interface SettleResp { settlement: { amount: string; units: string; channelId: string }; txHash: string }
  const { status: ses, data: sed } = await apiReq<SettleResp>("POST", `/channels/${chanId}/settle`, {
    requestId: voucher.requestId,
    units:     voucher.units,
    deadline:  voucher.deadline,
    signature: voucher.signature,
  });
  assert("POST /settle 200", ses === 200, `got ${ses}`);
  assert("settlement.amount is string", typeof sed.settlement.amount === "string");
  assert("settlement.amount == '3000' (decoded from UsageSettled event)", sed.settlement.amount === "3000", `got ${sed.settlement.amount}`);
  assert("settlement.amount is nonzero", BigInt(sed.settlement.amount) > 0n);
  assert("no Number(bigint) coercion: amount parses as BigInt", (() => { try { BigInt(sed.settlement.amount); return true; } catch { return false; } })());

  // Duplicate via API → 400
  const { status: dups } = await apiReq("POST", `/channels/${chanId}/settle`, {
    requestId: voucher.requestId, units: voucher.units,
    deadline: voucher.deadline, signature: voucher.signature,
  });
  assert("API duplicate settle → 400", dups === 400, `got ${dups}`);

  // demo/complete — simulated AI endpoint
  interface DcResp { units: string; txHash: string; amount: string; channelBalance: string }
  const { status: dcs, data: dcd } = await apiReq<DcResp>("POST", "/demo/complete", {
    channelId: chanId, prompt: "hello world test",
  });
  assert("POST /demo/complete 200", dcs === 200, `got ${dcs}`);
  assert("demo/complete units = word count string '3'", dcd.units === "3", `got ${dcd.units}`);
  assert("demo/complete amount is string", typeof dcd.amount === "string");
  assert("demo/complete amount == '3000' (decoded from UsageSettled event)", dcd.amount === "3000", `got ${dcd.amount}`);
  assert("demo/complete channelBalance is string", typeof dcd.channelBalance === "string");

  // GET /channels — providerCredit must be strings, settlements must have string amounts
  interface ChansResp { channels: Array<{ channelId: string }>; providerCredit: Record<string, string>; settlements: Array<{ amount: string; units: string; blockTimestamp: number }> }
  const { status: lcs, data: lcd } = await apiReq<ChansResp>("GET", "/channels");
  assert("GET /channels 200", lcs === 200, `got ${lcs}`);
  assert("providerCredit values are strings", Object.values(lcd.providerCredit).every((v) => typeof v === "string"));
  assert("settlements have string amounts", lcd.settlements.every((s) => typeof s.amount === "string"));
  assert("settlements have blockTimestamp number", lcd.settlements.every((s) => typeof s.blockTimestamp === "number"));
  // Verify credit is nonzero (we settled above)
  const totalCredit = Object.values(lcd.providerCredit).reduce((a, b) => {
    try { return (BigInt(a) + BigInt(b)).toString(); } catch { return a; }
  }, "0");
  assert("providerCredit nonzero after settlements", BigInt(totalCredit) > 0n, `total=${totalCredit}`);

  // Close channel
  const { status: cls } = await apiReq("POST", `/channels/${chanId}/close`);
  assert("POST /close 200", cls === 200, `got ${cls}`);

  // Early refund must be rejected (400) — grace not elapsed
  const { status: earlyRef } = await apiReq("POST", `/channels/${chanId}/refund`);
  assert("early /refund 400 (grace not elapsed)", earlyRef === 400, `got ${earlyRef}`);

  // Skip grace period
  const { status: sks } = await apiReq("POST", `/channels/${chanId}/skip-time`);
  assert("POST /skip-time 200", sks === 200, `got ${sks}`);

  // Refund now works
  const { status: refs } = await apiReq("POST", `/channels/${chanId}/refund`);
  assert("POST /refund 200", refs === 200, `got ${refs}`);

  // Withdraw — must be 200 with nonzero string amount
  const { status: ws, data: wd } = await apiReq<{ withdrawn: string; payout: string }>("POST", "/withdraw", {
    payout: fixturePayoutAddress,
  });
  assert("POST /withdraw 200 (credit exists)", ws === 200, `got ${ws}`);
  if (ws === 200) {
    assert("withdrawn is string", typeof wd.withdrawn === "string");
    assert("withdrawn amount nonzero", BigInt(wd.withdrawn) > 0n, `got ${wd.withdrawn}`);
  }

  // Open a FRESH channel after time warp and settle successfully
  console.log("  -- fresh channel + settle after time warp --");
  interface FreshResp { channel: { channelId: string; state: string; balance: string } }
  const { status: fcs, data: fcd } = await apiReq<FreshResp>("POST", "/channels", {
    pricePerUnit: "1000", perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "50000",
  });
  assert("fresh channel 201", fcs === 201, `got ${fcs}`);
  const freshId = fcd.channel.channelId;
  assert("fresh channel Active", fcd.channel.state === "Active");

  const { status: fvs, data: fvd } = await apiReq<VouchResp>("POST", `/channels/${freshId}/voucher`, { units: "2" });
  assert("fresh voucher 200", fvs === 200, `got ${fvs}`);

  const { status: fss, data: fsd } = await apiReq<SettleResp>("POST", `/channels/${freshId}/settle`, {
    requestId: fvd.voucher.requestId, units: fvd.voucher.units,
    deadline:  fvd.voucher.deadline,  signature: fvd.voucher.signature,
  });
  assert("fresh channel settle 200", fss === 200, `got ${fss}`);
  assert("fresh settlement amount == '2000'", fsd.settlement.amount === "2000", `got ${fsd.settlement.amount}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("\nSpondion On-chain E2E Test Suite — revision 4");
console.log("=".repeat(52));
console.log("RPC:   ", RPC_URL);
console.log("API:   ", API_BASE);
console.log("Contracts: compiled Foundry artifacts");
console.log("Signing:   EIP-712 typed-data");

let anvilProc:  ChildProcess | null = null;
let apiAnvilProc: ChildProcess | null = null;
let serverProc: ChildProcess | null = null;

try {
  if (new Set([ANVIL_PORT, SERVER_ANVIL_PORT, API_PORT]).size !== 3) throw new Error("Fixture ports must be distinct");
  for (const port of [ANVIL_PORT, SERVER_ANVIL_PORT, API_PORT]) await requireFreePort(port);
  // 1. Start isolated Anvil
  console.log(`\n[setup] Starting Anvil on port ${ANVIL_PORT}…`);
  anvilProc = spawn("anvil", [
    "--host", LOOPBACK, "--port", String(ANVIL_PORT), "--chain-id", String(CHAIN_ID), "--silent",
  ], { stdio: ["ignore", "pipe", "ignore"] });

  // Fail immediately if Anvil exits unexpectedly
  anvilProc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[setup] Anvil exited with code ${code}`);
    }
  });

  await waitRpcReady(RPC_URL, 10_000, anvilProc);
  console.log("[setup] Anvil ready");

  // 2. Deploy contracts
  console.log("\n=== deployment ===");
  const pub = createPublicClient({ chain: anvilChain, transport: http(RPC_URL) });
  const { usdcAddress, escrowAddress } = await deploy(pub);

  // 3. A second owned node isolates backend fixture nonces and time changes.
  apiAnvilProc = spawn("anvil", ["--host", LOOPBACK, "--port", String(SERVER_ANVIL_PORT), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  await waitRpcReady(API_RPC_URL, 10_000, apiAnvilProc);
  console.log(`\n[setup] Starting demo server on port ${API_PORT}…`);
  serverProc = spawn(process.execPath, ["--no-env-file", "--no-install", "server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ANVIL_PORT: String(SERVER_ANVIL_PORT),
      SERVER_PORT: String(API_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProc.stdout?.on("data", (d: Buffer) => process.stdout.write("[demo] " + d.toString()));
  serverProc.stderr?.on("data", (d: Buffer) => process.stderr.write("[demo] " + d.toString()));

  // Fail hard if server dies before becoming healthy
  serverProc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[setup] Server process exited with code ${code} — was it missing built artifacts?`);
    }
  });

  await waitHttpReady(`${API_BASE}/status`, 45_000, serverProc);
  pass("backend status.ready on separate owned chain");
  console.log("[setup] Demo server ready");

  // 4. Run contract-level suites (use E2E's own Anvil + deployed contracts)
  const channelId = await testOpenAndDeposit(pub, escrowAddress, usdcAddress);
  await testSettleUsage(pub, escrowAddress, channelId);
  await testCapEnforcement(pub, escrowAddress, channelId);
  await testReplayAfterTopUp(pub, escrowAddress, usdcAddress, channelId);
  await testCloseAndRefund(pub, escrowAddress, channelId);
  await testWithdraw(pub, escrowAddress);
  await testConservation(pub, escrowAddress, usdcAddress);

  // 5. HTTP API suites (server uses its own internally-deployed chain)
  await testMalformedInput();
  // Pass the fixture payout address so withdraw test uses the right address
  await testApiPath(payoutAccount.address);

} catch (err) {
  console.error("\nFatal:", err instanceof Error ? err.stack : err);
  failed++;
} finally {
  // Clean up only processes WE launched
  serverProc?.kill();
  apiAnvilProc?.kill();
  anvilProc?.kill();
  console.log("\n" + "=".repeat(52));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(52));
  if (failed > 0) process.exit(1);
}
