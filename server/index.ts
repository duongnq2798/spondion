/**
 * Spondion Demo Backend  –  revision 3 (decimal-string + origin allowlist pass)
 *
 * Security constraints (hard-coded, never configurable):
 *   [S1] Server binds exclusively to 127.0.0.1 — never 0.0.0.0.
 *   [S2] Strict Origin check on every state-mutating request (POST/OPTIONS).
 *        Only the Vite dev origin, localhost equivalents, and the Arc Studio
 *        preview hostname are accepted; all others get 403.  No wildcard CORS.
 *   [S3] assertLoopbackChain() is called immediately before every signing,
 *        contract write, or evm_ time-change — not only at startup.
 *   [S4] Every deploy/write receipt is checked for status==="success"; failure throws.
 *   [S5] Channel ID is decoded from the ChannelOpened log in the receipt — never
 *        inferred from nextChannelId-1 (avoids concurrent-open race).
 *   [S6] Settlement history is rebuilt on every GET /channels from on-chain
 *        UsageSettled logs + block timestamps since deployBlock.  No in-memory ledger.
 *   [S7] Voucher deadlines use block.timestamp from the chain, not Date.now().
 *   [S8] skip-time skip amount is computed from on-chain block.timestamp vs
 *        refundAvailableAt, not wall-clock time.
 *   [S9] Fixture private keys are server-side only; the frontend never sees them.
 *   [S10] All amounts parsed as decimal integer strings → BigInt; no Number(x) cast.
 *   [S11] Leading-zero integer strings are rejected (e.g. "01000" → 400).
 *
 * Production note: LOCAL DEMO only.  Real deployment uses env-provided addresses
 * and user-wallet EIP-1193 signing.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getContract,
  decodeEventLog,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil as anvilChain } from "viem/chains";

// ── Constants ──────────────────────────────────────────────────────────────────

const REQUIRED_CHAIN_ID = 31337;
const LOOPBACK          = "127.0.0.1";
const ANVIL_PORT        = Number(process.env["ANVIL_PORT"]  ?? 8545);
const SERVER_PORT       = Number(process.env["SERVER_PORT"] ?? 3001);
const RPC_URL           = `http://${LOOPBACK}:${ANVIL_PORT}`;
const GRACE_DURATION    = BigInt(1 * 60 * 60); // 1 hour

// Allowed Origins for state-mutating requests.  [S2]
// Same-origin requests (no Origin header) are always allowed.
// The Arc Studio preview hostname is explicitly allowed for in-browser demo use.
const ALLOWED_ORIGINS = new Set([
  `http://${LOOPBACK}:5173`,
  `http://localhost:5173`,
  `http://${LOOPBACK}:${SERVER_PORT}`,
  `http://localhost:${SERVER_PORT}`,
  // Arc Studio preview (read from env so the E2E can also override if needed)
  ...(process.env["ALLOWED_ORIGIN"] ? [process.env["ALLOWED_ORIGIN"]] : [
    "https://ihyne00e984oeo8ixk64b.preview.studio.arc.io",
  ]),
]);

// Anvil default funded accounts (publicly-known test keys — safe for demo server only).
const FIXTURE_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner:    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  provider: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  payout:   "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

// ── Artifact paths ─────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");

function loadArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const p = join(ROOT, "contracts", "out", `${name}.sol`, `${name}.json`);
  const d = JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: d.abi, bytecode: d.bytecode.object };
}

// ── ABIs ───────────────────────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
]);

// Object-format ABI to avoid abitype tuple-with-names limitation in parseAbi.
const ESCROW_ABI = [
  { type: "function", name: "openChannel",    stateMutability: "nonpayable", inputs: [{ name: "provider",     type: "address" }, { name: "payout",      type: "address" }, { name: "signer",       type: "address" }, { name: "pricePerUnit", type: "uint256" }, { name: "perCallCap",  type: "uint256" }, { name: "lifetimeCap", type: "uint256" }], outputs: [{ name: "channelId", type: "uint256" }] },
  { type: "function", name: "deposit",        stateMutability: "nonpayable", inputs: [{ name: "channelId",   type: "uint256" }, { name: "amount",      type: "uint256" }], outputs: [] },
  { type: "function", name: "settleUsage",    stateMutability: "nonpayable", inputs: [{ name: "channelId",   type: "uint256" }, { name: "requestId",   type: "bytes32" }, { name: "units",        type: "uint256" }, { name: "deadline",    type: "uint256" }, { name: "signature",   type: "bytes"   }], outputs: [] },
  { type: "function", name: "requestClose",   stateMutability: "nonpayable", inputs: [{ name: "channelId",   type: "uint256" }], outputs: [] },
  { type: "function", name: "finalizeRefund", stateMutability: "nonpayable", inputs: [{ name: "channelId",   type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw",       stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function", name: "getChannel", stateMutability: "view",
    inputs: [{ name: "channelId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "owner",            type: "address" }, { name: "provider",        type: "address" },
      { name: "payout",           type: "address" }, { name: "signer",          type: "address" },
      { name: "pricePerUnit",     type: "uint256" }, { name: "perCallCap",      type: "uint256" },
      { name: "lifetimeCap",      type: "uint256" }, { name: "balance",         type: "uint256" },
      { name: "spent",            type: "uint256" }, { name: "refundAvailableAt", type: "uint256" },
      { name: "state",            type: "uint8"   },
    ]}],
  },
  { type: "function", name: "isVoucherConsumed", stateMutability: "view",    inputs: [{ name: "channelId", type: "uint256" }, { name: "requestId", type: "bytes32" }], outputs: [{ name: "", type: "bool"    }] },
  { type: "function", name: "getDomainSeparator",stateMutability: "view",    inputs: [], outputs: [{ name: "", type: "bytes32"  }] },
  { type: "function", name: "hashVoucher",        stateMutability: "view",    inputs: [{ name: "channelId", type: "uint256" }, { name: "requestId", type: "bytes32" }, { name: "units", type: "uint256" }, { name: "deadline", type: "uint256" }], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "nextChannelId",      stateMutability: "view",    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "providerCredit",     stateMutability: "view",    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalLiabilities",   stateMutability: "view",    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "usdc",               stateMutability: "view",    inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "event", name: "ChannelOpened",  inputs: [{ name: "channelId",  type: "uint256", indexed: true }, { name: "owner",     type: "address", indexed: true }, { name: "provider",    type: "address", indexed: true }, { name: "payout",       type: "address", indexed: false }, { name: "signer",      type: "address", indexed: false }, { name: "pricePerUnit", type: "uint256", indexed: false }, { name: "perCallCap",  type: "uint256", indexed: false }, { name: "lifetimeCap", type: "uint256", indexed: false }] },
  { type: "event", name: "UsageSettled",   inputs: [{ name: "channelId",  type: "uint256", indexed: true }, { name: "requestId", type: "bytes32", indexed: true }, { name: "units",       type: "uint256", indexed: false }, { name: "amount",       type: "uint256", indexed: false }] },
  { type: "event", name: "Deposited",      inputs: [{ name: "channelId",  type: "uint256", indexed: true }, { name: "amount",    type: "uint256", indexed: false }, { name: "newBalance",  type: "uint256", indexed: false }] },
  { type: "event", name: "ClosingRequested",inputs: [{ name: "channelId", type: "uint256", indexed: true }, { name: "refundAvailableAt", type: "uint256", indexed: false }] },
  { type: "event", name: "Refunded",       inputs: [{ name: "channelId",  type: "uint256", indexed: true }, { name: "amount",    type: "uint256", indexed: false }, { name: "owner",       type: "address", indexed: false }] },
  { type: "event", name: "ProviderWithdrawn", inputs: [{ name: "payout",  type: "address", indexed: true }, { name: "amount",    type: "uint256", indexed: false }] },
] as const;

// ── Accounts ───────────────────────────────────────────────────────────────────

const deployerAccount = privateKeyToAccount(FIXTURE_KEYS.deployer);
const ownerAccount    = privateKeyToAccount(FIXTURE_KEYS.owner);
const providerAccount = privateKeyToAccount(FIXTURE_KEYS.provider);
const payoutAccount   = privateKeyToAccount(FIXTURE_KEYS.payout);

// ── Node state ─────────────────────────────────────────────────────────────────

interface NodeState {
  ready:           boolean;
  escrow:          Address;
  usdc:            Address;
  deployBlock:     bigint;   // [S6] scan UsageSettled logs from this block
  ownerAddress:    Address;
  providerAddress: Address;
  payoutAddress:   Address;
}

let nodeState:    NodeState | null = null;
let anvilProcess: ReturnType<typeof spawn> | null = null;

// ── Security guards ────────────────────────────────────────────────────────────

/** [S3] Called immediately before every sign / write / evm_ operation. */
async function assertLoopbackChain(): Promise<void> {
  if (!RPC_URL.startsWith(`http://${LOOPBACK}:`)) {
    throw new Error(`SECURITY: RPC_URL ${RPC_URL} is not loopback-only.`);
  }
  const pub = createPublicClient({ chain: anvilChain, transport: http(RPC_URL) });
  const cid = await pub.getChainId();
  if (cid !== REQUIRED_CHAIN_ID) {
    throw new Error(`SECURITY: chainId ${cid} != ${REQUIRED_CHAIN_ID}. Only loopback Anvil (chainId 31337) is permitted.`);
  }
}

/** [S2] Returns an error string if the request origin is not allowed; null if OK.
 *  GET/HEAD are never blocked.  Absent Origin (same-origin via proxy) is allowed. */
function checkOrigin(req: IncomingMessage): string | null {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return null;
  const origin = req.headers["origin"];
  if (!origin) return null;                       // same-origin (no Origin header)
  if (ALLOWED_ORIGINS.has(origin)) return null;   // known-good origin
  return `Forbidden: cross-origin mutation from "${origin}" is not allowed.`;
}

// ── Receipt checker ────────────────────────────────────────────────────────────

/** [S4] Throws if a receipt does not have status "success". */
function requireSuccess(receipt: TransactionReceipt, label: string): void {
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${receipt.transactionHash} (${label}) reverted. Status: ${receipt.status}`);
  }
}

// ── Chain helpers ──────────────────────────────────────────────────────────────

/** [S7] Returns the latest block's timestamp from the chain — not Date.now(). */
async function chainBlockTimestamp(): Promise<bigint> {
  const r = await fetch(RPC_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", false], id: 1 }),
  });
  const d = await r.json() as { result: { timestamp: string } };
  return BigInt(d.result.timestamp);
}

/** Cross-platform Anvil readiness check — uses fetch, not curl. */
async function isAnvilReady(): Promise<boolean> {
  try {
    const r = await fetch(RPC_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
    });
    return r.ok;
  } catch { return false; }
}

// ── Wallet factory ─────────────────────────────────────────────────────────────

function makeWallet(acct: ReturnType<typeof privateKeyToAccount>) {
  return createWalletClient({ account: acct, chain: anvilChain, transport: http(RPC_URL) });
}

function makePub() {
  return createPublicClient({ chain: anvilChain, transport: http(RPC_URL) });
}

// ── Anvil lifecycle ────────────────────────────────────────────────────────────

async function startAnvilAndDeploy(): Promise<void> {
  console.log("[server] Starting Anvil on", RPC_URL);

  if (!(await isAnvilReady())) {
    anvilProcess = spawn("anvil", [
      "--host", LOOPBACK,                    // [S1] loopback only
      "--port", String(ANVIL_PORT),
      "--chain-id", String(REQUIRED_CHAIN_ID),
    ], { stdio: ["ignore", "pipe", "pipe"] });

    anvilProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[anvil] ${d}`));
    anvilProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[anvil] ${d}`));

    for (let i = 0; i < 100; i++) {
      if (await isAnvilReady()) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!(await isAnvilReady())) throw new Error("Anvil failed to start");
    console.log("[server] Anvil ready");
  } else {
    console.log("[server] Anvil already running — reusing");
  }

  await assertLoopbackChain(); // [S3] before any deployment write

  const pub            = makePub();
  const deployerWallet = makeWallet(deployerAccount);
  const ownerWallet    = makeWallet(ownerAccount);

  // Deploy MockUSDC
  console.log("[server] Deploying MockUSDC…");
  const usdcArt = loadArtifact("MockUSDC");
  const usdcData = (usdcArt.bytecode + encodeAbiParameters(parseAbiParameters("uint8"), [6]).slice(2)) as `0x${string}`;
  const usdcR = await pub.waitForTransactionReceipt({ hash: await deployerWallet.sendTransaction({ data: usdcData, gas: 2_000_000n }) });
  requireSuccess(usdcR, "MockUSDC deploy"); // [S4]
  const usdcAddress = usdcR.contractAddress as Address;
  console.log("[server] MockUSDC at", usdcAddress);

  // Deploy SpondionPrepaidEscrow
  console.log("[server] Deploying SpondionPrepaidEscrow…");
  const escrowArt = loadArtifact("SpondionPrepaidEscrow");
  const escrowData = (escrowArt.bytecode + encodeAbiParameters(parseAbiParameters("address, uint256"), [usdcAddress, GRACE_DURATION]).slice(2)) as `0x${string}`;
  const escrowR = await pub.waitForTransactionReceipt({ hash: await deployerWallet.sendTransaction({ data: escrowData, gas: 3_000_000n }) });
  requireSuccess(escrowR, "Escrow deploy"); // [S4]
  const escrowAddress = escrowR.contractAddress as Address;
  const deployBlock   = escrowR.blockNumber;              // [S6]
  console.log("[server] Escrow at", escrowAddress, "block", deployBlock);

  // Mint & approve
  const MINT = 10_000_000n;
  const usdcCt = getContract({ address: usdcAddress, abi: ERC20_ABI, client: deployerWallet });
  requireSuccess(await pub.waitForTransactionReceipt({ hash: await usdcCt.write.mint([ownerAccount.address, MINT]) }), "mint owner");
  requireSuccess(await pub.waitForTransactionReceipt({ hash: await usdcCt.write.mint([providerAccount.address, MINT]) }), "mint provider");
  const usdcOwner = getContract({ address: usdcAddress, abi: ERC20_ABI, client: ownerWallet });
  requireSuccess(await pub.waitForTransactionReceipt({ hash: await usdcOwner.write.approve([escrowAddress, MINT]) }), "owner approve");

  nodeState = {
    ready: true, escrow: escrowAddress, usdc: usdcAddress,
    deployBlock,
    ownerAddress: ownerAccount.address,
    providerAddress: providerAccount.address,
    payoutAddress: payoutAccount.address,
  };
  console.log("[server] Deployment complete. Node ready.");
}

// ── EIP-712 voucher signing ────────────────────────────────────────────────────

const VOUCHER_TYPE = {
  UsageVoucher: [
    { name: "channelId", type: "uint256" },
    { name: "requestId", type: "bytes32" },
    { name: "units",     type: "uint256" },
    { name: "deadline",  type: "uint256" },
  ],
} as const;

async function signVoucher(
  escrowAddress: Address,
  channelId: bigint,
  requestId: `0x${string}`,
  units: bigint,
  deadline: bigint,
): Promise<`0x${string}`> {
  await assertLoopbackChain(); // [S3]
  const wallet = makeWallet(ownerAccount);
  return wallet.signTypedData({
    domain: { name: "SpondionPrepaidEscrow", version: "1", chainId: REQUIRED_CHAIN_ID, verifyingContract: escrowAddress },
    types: VOUCHER_TYPE,
    primaryType: "UsageVoucher",
    message: { channelId, requestId, units, deadline },
  });
}

// ── Settlement history from chain ──────────────────────────────────────────────

/** [S6][S10] Settlement shape — all amounts are decimal strings. */
interface Settlement {
  channelId:      string;
  requestId:      string;
  units:          string;  // [S10] decimal string
  amount:         string;  // [S10] decimal string
  blockTimestamp: number;  // [S6] from the block that mined the event
  txHash:         string;
}

/** [S6] Rebuilds full settlement history from on-chain UsageSettled logs.
 *  Never uses an in-memory log that could be stale or miss direct-chain settlements. */
async function fetchSettlementsFromChain(escrowAddress: Address, fromBlock: bigint): Promise<Settlement[]> {
  const pub = makePub();
  const logs = await pub.getLogs({
    address: escrowAddress,
    event: {
      type: "event", name: "UsageSettled",
      inputs: [
        { name: "channelId", type: "uint256", indexed: true },
        { name: "requestId", type: "bytes32", indexed: true },
        { name: "units",     type: "uint256", indexed: false },
        { name: "amount",    type: "uint256", indexed: false },
      ],
    },
    fromBlock,
    toBlock: "latest",
  });

  const results: Settlement[] = [];
  for (const log of logs) {
    const block = await pub.getBlock({ blockNumber: log.blockNumber });
    const args  = log.args as { channelId: bigint; requestId: `0x${string}`; units: bigint; amount: bigint };
    results.push({
      channelId:      args.channelId.toString(),  // [S10]
      requestId:      args.requestId,
      units:          args.units.toString(),       // [S10] string, not Number
      amount:         args.amount.toString(),      // [S10] string, not Number
      blockTimestamp: Number(block.timestamp),
      txHash:         log.transactionHash ?? "0x",
    });
  }
  return results;
}

// ── HTTP utilities ─────────────────────────────────────────────────────────────

interface ApiError { error: string }

/** [S2] No wildcard CORS — Vite proxy provides same-origin browser access. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin":  `http://${LOOPBACK}:5173`,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c: Buffer) => { raw += c.toString(); });
    req.on("end", () => {
      try { resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

/**
 * [S10][S11] Parse a field from the request body as a non-negative BigInt.
 * Rejects floats, negatives, leading zeros (except "0" itself), and empty strings.
 */
function parseBigInt(val: unknown, fieldName: string, min = 0n, max = 2n ** 256n - 1n): { ok: true; value: bigint } | { ok: false; error: string } {
  if (val === undefined || val === null || val === "") return { ok: false, error: `${fieldName}: missing` };
  // JSON numbers may already have lost precision before this handler sees them.
  if (typeof val !== "string") return { ok: false, error: `${fieldName}: must be a decimal integer string` };
  const s = val.trim();
  // Must be a non-empty string of digits only — no sign, no dot, no exponent.
  if (!/^\d+$/.test(s)) return { ok: false, error: `${fieldName}: must be a non-negative integer string (no sign, no decimal point)` };
  // Reject leading zeros except the single digit "0". [S11]
  if (s.length > 1 && s[0] === "0") return { ok: false, error: `${fieldName}: leading zeros not allowed` };
  const v = BigInt(s);
  if (v < min) return { ok: false, error: `${fieldName}: must be >= ${min}` };
  if (v > max) return { ok: false, error: `${fieldName}: must be <= ${max}` };
  return { ok: true, value: v };
}

function route(req: IncomingMessage): { method: string; path: string; params: Record<string, string> } {
  const method  = req.method ?? "GET";
  const rawPath = (req.url ?? "/").split("?")[0];
  const chanId   = rawPath.match(/^\/channels\/([^/]+)$/);
  if (chanId)   return { method, path: "/channels/:id",           params: { id: chanId[1] } };
  const voucher  = rawPath.match(/^\/channels\/([^/]+)\/voucher$/);
  if (voucher)  return { method, path: "/channels/:id/voucher",   params: { id: voucher[1] } };
  const settle   = rawPath.match(/^\/channels\/([^/]+)\/settle$/);
  if (settle)   return { method, path: "/channels/:id/settle",    params: { id: settle[1] } };
  const close_   = rawPath.match(/^\/channels\/([^/]+)\/close$/);
  if (close_)   return { method, path: "/channels/:id/close",     params: { id: close_[1] } };
  const refund   = rawPath.match(/^\/channels\/([^/]+)\/refund$/);
  if (refund)   return { method, path: "/channels/:id/refund",    params: { id: refund[1] } };
  const timeSkip = rawPath.match(/^\/channels\/([^/]+)\/skip-time$/);
  if (timeSkip) return { method, path: "/channels/:id/skip-time", params: { id: timeSkip[1] } };
  return { method, path: rawPath, params: {} };
}

// ── Channel reader ─────────────────────────────────────────────────────────────

const STATE_NAMES = ["Active", "Closing", "Closed"] as const;

interface ChainChannel {
  channelId: string; owner: string; provider: string; payout: string; signer: string;
  pricePerUnit: string; perCallCap: string; lifetimeCap: string;
  balance: string; spent: string; refundAvailableAt: string;
  state: "Active" | "Closing" | "Closed";
}

async function readChannel(pub: ReturnType<typeof createPublicClient>, escrowAddress: Address, channelId: bigint): Promise<ChainChannel> {
  const ch = await pub.readContract({
    address: escrowAddress, abi: ESCROW_ABI, functionName: "getChannel", args: [channelId],
  }) as {
    owner: Address; provider: Address; payout: Address; signer: Address;
    pricePerUnit: bigint; perCallCap: bigint; lifetimeCap: bigint;
    balance: bigint; spent: bigint; refundAvailableAt: bigint; state: number;
  };
  return {
    channelId: channelId.toString(),
    owner: ch.owner, provider: ch.provider, payout: ch.payout, signer: ch.signer,
    pricePerUnit: ch.pricePerUnit.toString(), perCallCap: ch.perCallCap.toString(),
    lifetimeCap: ch.lifetimeCap.toString(), balance: ch.balance.toString(),
    spent: ch.spent.toString(), refundAvailableAt: ch.refundAvailableAt.toString(),
    state: STATE_NAMES[ch.state] ?? "Active",
  };
}

async function allChannels(pub: ReturnType<typeof createPublicClient>, escrowAddress: Address): Promise<ChainChannel[]> {
  const next = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "nextChannelId", args: [] }) as bigint;
  const results: ChainChannel[] = [];
  for (let i = 0n; i < next; i++) results.push(await readChannel(pub, escrowAddress, i));
  return results;
}

// ── Nonce serialiser ───────────────────────────────────────────────────────────
// Anvil is single-threaded so parallel write() calls can collide on nonce.
// We serialise all writes through a promise queue so each tx is sent only after
// the previous one has been mined (waitForTransactionReceipt).

let _writeQueue: Promise<void> = Promise.resolve();

/** Run a write task exclusively — waits for all prior tasks before starting. */
function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  let resolve!: (v: T) => void;
  let reject!:  (e: unknown) => void;
  const outer = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  _writeQueue = _writeQueue.then(async () => {
    try { resolve(await task()); } catch (e) { reject(e); }
  });
  return outer;
}

// ── Request handler ────────────────────────────────────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // [S2] Preflight
  if (req.method === "OPTIONS") {
    const originErr = checkOrigin(req);
    if (originErr) { res.writeHead(403); res.end(originErr); return; }
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  req.headers["origin"] ?? `http://${LOOPBACK}:5173`,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // [S2] Block hostile-origin mutations before reading the body.
  const originErr = checkOrigin(req);
  if (originErr) return json(res, 403, { error: originErr } satisfies ApiError);

  const { method, path, params } = route(req);

  try {
    // GET /health
    if (method === "GET" && path === "/health") {
      return json(res, 200, { status: "ok", chainId: REQUIRED_CHAIN_ID, rpcUrl: RPC_URL });
    }
    // GET /status
    if (method === "GET" && path === "/status") {
      if (!nodeState) return json(res, 200, { ready: false });
      return json(res, 200, {
        ready: nodeState.ready, chainId: REQUIRED_CHAIN_ID,
        escrow: nodeState.escrow, usdc: nodeState.usdc, rpcUrl: RPC_URL,
        fixture: { owner: nodeState.ownerAddress, provider: nodeState.providerAddress, payout: nodeState.payoutAddress },
      });
    }

    if (!nodeState?.ready) return json(res, 503, { error: "Node not ready yet. Retry in a moment." });
    const { escrow: escrowAddress, usdc: usdcAddress, deployBlock } = nodeState;
    const pub = makePub();

    // ── GET /channels ────────────────────────────────────────────────────────
    if (method === "GET" && path === "/channels") {
      const channels  = await allChannels(pub, escrowAddress);
      const payouts   = [...new Set(channels.map((c) => c.payout as Address))];
      const creditArr = await Promise.all(
        payouts.map(async (p) => {
          const raw = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "providerCredit", args: [p] }) as bigint;
          return [p, raw.toString()] as [string, string]; // [S10] string
        })
      );
      const providerCredit = Object.fromEntries(creditArr);
      const settlements    = await fetchSettlementsFromChain(escrowAddress, deployBlock); // [S6]
      return json(res, 200, { channels, providerCredit, settlements });
    }

    // ── POST /channels — open + optional deposit ─────────────────────────────
    if (method === "POST" && path === "/channels") {
      const body = await readBody(req);

      const pp  = parseBigInt(body.pricePerUnit   ?? "1000",  "pricePerUnit",  1n);
      const pc  = parseBigInt(body.perCallCap     ?? "10000", "perCallCap",    1n);
      const lc  = parseBigInt(body.lifetimeCap    ?? "100000","lifetimeCap",   1n);
      const dep = parseBigInt(body.initialDeposit ?? "0",     "initialDeposit",0n);
      for (const r of [pp, pc, lc, dep]) if (!r.ok) return json(res, 400, { error: r.error } satisfies ApiError);
      if (!pp.ok || !pc.ok || !lc.ok || !dep.ok) return; // narrowing
      if (pc.value > lc.value) return json(res, 400, { error: "perCallCap > lifetimeCap" } satisfies ApiError);

      const channel = await enqueueWrite(async () => {
        await assertLoopbackChain(); // [S3]
        const ownerWallet = makeWallet(ownerAccount);
        const openHash    = await ownerWallet.writeContract({
          address: escrowAddress, abi: ESCROW_ABI, functionName: "openChannel",
          args: [nodeState!.providerAddress, nodeState!.payoutAddress, "0x0000000000000000000000000000000000000000",
                 pp.value, pc.value, lc.value],
        });
        const openReceipt = await pub.waitForTransactionReceipt({ hash: openHash });
        requireSuccess(openReceipt, "openChannel"); // [S4]

        // [S5] Decode channelId from ChannelOpened log — never use nextChannelId-1.
        let channelId: bigint | undefined;
        for (const log of openReceipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
            if (decoded.eventName === "ChannelOpened") {
              channelId = (decoded.args as { channelId: bigint }).channelId;
              break;
            }
          } catch { /* skip non-matching logs */ }
        }
        if (channelId === undefined) throw new Error("ChannelOpened event not found in receipt");

        if (dep.value > 0n) {
          await assertLoopbackChain(); // [S3]
          const usdcCt = getContract({ address: usdcAddress, abi: ERC20_ABI, client: makeWallet(ownerAccount) });
          requireSuccess(await pub.waitForTransactionReceipt({ hash: await usdcCt.write.approve([escrowAddress, dep.value]) }), "approve deposit");
          requireSuccess(await pub.waitForTransactionReceipt({
            hash: await ownerWallet.writeContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "deposit", args: [channelId, dep.value] }),
          }), "deposit"); // [S4]
        }

        return { channel: await readChannel(pub, escrowAddress, channelId), txHash: openReceipt.transactionHash };
      });
      return json(res, 201, channel);
    }

    // ── GET /channels/:id ────────────────────────────────────────────────────
    if (method === "GET" && path === "/channels/:id") {
      const id   = BigInt(params.id);
      const next = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "nextChannelId", args: [] }) as bigint;
      if (id >= next) return json(res, 404, { error: "channel not found" } satisfies ApiError);
      return json(res, 200, { channel: await readChannel(pub, escrowAddress, id) });
    }

    // ── POST /channels/:id/voucher ───────────────────────────────────────────
    if (method === "POST" && path === "/channels/:id/voucher") {
      const body      = await readBody(req);
      const channelId = BigInt(params.id);
      const ur = parseBigInt(body.units ?? "1", "units", 1n);
      if (!ur.ok) return json(res, 400, { error: ur.error } satisfies ApiError);
      const units = ur.value;

      const next = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "nextChannelId", args: [] }) as bigint;
      if (channelId >= next) return json(res, 404, { error: "channel not found" } satisfies ApiError);

      const ch = await readChannel(pub, escrowAddress, channelId);
      if (ch.state !== "Active") return json(res, 400, { error: `channel state is ${ch.state}` } satisfies ApiError);

      const amount = units * BigInt(ch.pricePerUnit);
      if (amount > BigInt(ch.perCallCap))                              return json(res, 400, { error: "units exceed per-call cap" } satisfies ApiError);
      if (BigInt(ch.spent) + amount > BigInt(ch.lifetimeCap))          return json(res, 400, { error: "would exceed lifetime cap" } satisfies ApiError);
      if (BigInt(ch.balance) < amount)                                  return json(res, 402, { error: "insufficient channel balance" } satisfies ApiError);

      const requestId   = `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`;
      const chainNow    = await chainBlockTimestamp();                  // [S7]
      const deadlineSec = chainNow + 300n;                             // 5 min chain-time window

      await assertLoopbackChain(); // [S3]
      const signature   = await signVoucher(escrowAddress, channelId, requestId, units, deadlineSec);

      return json(res, 200, {
        voucher: {
          channelId: channelId.toString(),
          requestId,
          units:    units.toString(),        // [S10] string
          deadline: deadlineSec.toString(),  // [S10] string
          deadlineMs: Number(deadlineSec) * 1000,
          signature,
        },
        signedBy: ownerAccount.address, signingMethod: "EIP-712",
      });
    }

    // ── POST /channels/:id/settle ────────────────────────────────────────────
    if (method === "POST" && path === "/channels/:id/settle") {
      const body      = await readBody(req);
      const channelId = BigInt(params.id);
      const requestId = String(body.requestId ?? "") as `0x${string}`;
      const signature = String(body.signature  ?? "") as `0x${string}`;
      if (!requestId || !signature) return json(res, 400, { error: "requestId + signature required" } satisfies ApiError);

      const ur = parseBigInt(body.units    ?? "", "units",    1n);
      const dr = parseBigInt(body.deadline ?? "", "deadline", 0n);
      if (!ur.ok) return json(res, 400, { error: ur.error } satisfies ApiError);
      if (!dr.ok) return json(res, 400, { error: dr.error } satisfies ApiError);
      const units = ur.value, deadline = dr.value;

      // [S7] Compare against chain block.timestamp, not Date.now().
      const chainNow = await chainBlockTimestamp();
      if (chainNow > deadline) return json(res, 400, { error: "voucher expired (chain time)" } satisfies ApiError);

      const next = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "nextChannelId", args: [] }) as bigint;
      if (channelId >= next) return json(res, 404, { error: "channel not found" } satisfies ApiError);

      const consumed = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "isVoucherConsumed", args: [channelId, requestId] }) as boolean;
      if (consumed) return json(res, 400, { error: "voucher already used" } satisfies ApiError);

      const { settleHash, receipt, settledAmount, ch, credit } = await enqueueWrite(async () => {
        await assertLoopbackChain(); // [S3]
        const settleHash    = await makeWallet(providerAccount).writeContract({
          address: escrowAddress, abi: ESCROW_ABI, functionName: "settleUsage",
          args: [channelId, requestId, units, deadline, signature],
        });
        const receipt = await pub.waitForTransactionReceipt({ hash: settleHash });
        requireSuccess(receipt, "settleUsage"); // [S4]

        // [S6] Decode amount from receipt event — do not fabricate it, no fallback.
        let settledAmount: bigint | undefined;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
            if (decoded.eventName === "UsageSettled") {
              settledAmount = (decoded.args as { amount: bigint }).amount; break;
            }
          } catch { /* skip */ }
        }
        if (settledAmount === undefined) throw new Error("UsageSettled event not found in settle receipt");

        const ch     = await readChannel(pub, escrowAddress, channelId);
        const credit = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "providerCredit", args: [ch.payout as Address] }) as bigint;
        return { settleHash, receipt, settledAmount, ch, credit };
      });

      return json(res, 200, {
        settlement: {
          channelId:      channelId.toString(),
          requestId,
          units:          units.toString(),          // [S10] string
          amount:         settledAmount.toString(),  // [S10] string — from event, not fabricated
          blockTimestamp: Number(chainNow),
          txHash:         settleHash,
        },
        channelBalance: ch.balance,
        providerCredit: credit.toString(),            // [S10] string
        txHash: settleHash, blockNumber: receipt.blockNumber.toString(),
      });
    }

    // ── POST /channels/:id/close ─────────────────────────────────────────────
    if (method === "POST" && path === "/channels/:id/close") {
      const channelId = BigInt(params.id);
      const next = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "nextChannelId", args: [] }) as bigint;
      if (channelId >= next) return json(res, 404, { error: "channel not found" } satisfies ApiError);
      const ch = await readChannel(pub, escrowAddress, channelId);
      if (ch.state !== "Active") return json(res, 400, { error: `channel state is ${ch.state}` } satisfies ApiError);

      const { hash, updated } = await enqueueWrite(async () => {
        await assertLoopbackChain(); // [S3]
        const hash    = await makeWallet(ownerAccount).writeContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "requestClose", args: [channelId] });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        requireSuccess(receipt, "requestClose"); // [S4]
        const updated = await readChannel(pub, escrowAddress, channelId);
        return { hash, updated };
      });
      return json(res, 200, { channel: updated, txHash: hash, refundAvailableAt: updated.refundAvailableAt });
    }

    // ── POST /channels/:id/skip-time ─────────────────────────────────────────
    if (method === "POST" && path === "/channels/:id/skip-time") {
      const channelId = BigInt(params.id);
      const ch = await readChannel(pub, escrowAddress, channelId);
      if (ch.state !== "Closing") return json(res, 400, { error: "channel not in Closing state" } satisfies ApiError);

      // [S8] Use chain block.timestamp — not wall clock.
      await assertLoopbackChain(); // [S3]
      const refundAt = BigInt(ch.refundAvailableAt);
      const chainNow = await chainBlockTimestamp();
      const skip     = refundAt > chainNow ? Number(refundAt - chainNow) + 2 : 2;

      await fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "evm_increaseTime", params: [skip], id: 1 }) });
      await fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "evm_mine", params: [], id: 2 }) });
      return json(res, 200, { skippedSeconds: skip, message: "Grace period elapsed — call /refund now" });
    }

    // ── POST /channels/:id/refund ────────────────────────────────────────────
    if (method === "POST" && path === "/channels/:id/refund") {
      const channelId = BigInt(params.id);
      const ch = await readChannel(pub, escrowAddress, channelId);
      if (ch.state !== "Closing") return json(res, 400, { error: "channel not in Closing state" } satisfies ApiError);
      // Check grace period using chain block.timestamp [S7] — return 400 (not 500) if not elapsed.
      const latestBlock = await pub.getBlock({ blockTag: "latest" });
      const refundAt    = BigInt(ch.refundAvailableAt);
      if (latestBlock.timestamp < refundAt) {
        return json(res, 400, { error: `grace period has not elapsed yet (refundAvailableAt=${ch.refundAvailableAt})` } satisfies ApiError);
      }

      const { hash, updated } = await enqueueWrite(async () => {
        await assertLoopbackChain(); // [S3]
        const hash    = await makeWallet(ownerAccount).writeContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "finalizeRefund", args: [channelId] });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        requireSuccess(receipt, "finalizeRefund"); // [S4]
        const updated = await readChannel(pub, escrowAddress, channelId);
        return { hash, updated };
      });
      return json(res, 200, { refunded: ch.balance, channel: updated, txHash: hash });
    }

    // ── POST /withdraw ───────────────────────────────────────────────────────
    if (method === "POST" && path === "/withdraw") {
      const body       = await readBody(req);
      const payoutAddr = String(body.payout ?? nodeState.payoutAddress) as Address;

      // Guard: the payout address must match the fixture payout (caller / payout mismatch rejection).
      // withdraw() sends to msg.sender, so the fixture payoutAccount must be the caller.
      if (payoutAddr.toLowerCase() !== payoutAccount.address.toLowerCase()) {
        return json(res, 400, { error: "payout address does not match fixture payout account" } satisfies ApiError);
      }

      const withdrawal = await enqueueWrite(async () => {
        // Credit must be read after prior queued writes, including withdrawals.
        const credit = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "providerCredit", args: [payoutAccount.address] }) as bigint;
        if (credit === 0n) return null;
        await assertLoopbackChain(); // [S3]
        const hash    = await makeWallet(payoutAccount).writeContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "withdraw", args: [] });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        requireSuccess(receipt, "withdraw"); // [S4]
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== escrowAddress.toLowerCase()) continue;
          try {
            const decoded = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
            if (decoded.eventName !== "ProviderWithdrawn") continue;
            const event = decoded.args as { payout: Address; amount: bigint };
            if (event.payout.toLowerCase() !== payoutAccount.address.toLowerCase()) continue;
            return { hash, amount: event.amount, payout: event.payout };
          } catch { /* skip non-matching receipt logs */ }
        }
        throw new Error("ProviderWithdrawn event not found in successful withdrawal receipt");
      });
      if (!withdrawal) return json(res, 400, { error: "no credit to withdraw" } satisfies ApiError);
      return json(res, 200, { withdrawn: withdrawal.amount.toString(), payout: withdrawal.payout, txHash: withdrawal.hash }); // [S10] event-derived string
    }

    // ── POST /demo/complete — AI call simulation: measure words → settle ──────
    if (method === "POST" && path === "/demo/complete") {
      const body      = await readBody(req);
      const cr = parseBigInt(body.channelId ?? "0", "channelId", 0n);
      if (!cr.ok) return json(res, 400, { error: cr.error } satisfies ApiError);
      const channelId = cr.value;

      const next = await pub.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "nextChannelId", args: [] }) as bigint;
      if (channelId >= next) return json(res, 404, { error: "channel not found" } satisfies ApiError);

      const ch = await readChannel(pub, escrowAddress, channelId);
      if (ch.state !== "Active") return json(res, 400, { error: `channel state is ${ch.state}` } satisfies ApiError);

      const prompt   = String(body.prompt || "demo request");
      const words    = prompt.trim().split(/\s+/).length;
      const maxUnits = Number(BigInt(ch.perCallCap) / BigInt(ch.pricePerUnit));
      const units    = BigInt(Math.min(Math.max(words, 1), maxUnits));
      const amount   = units * BigInt(ch.pricePerUnit);

      if (BigInt(ch.balance) < amount)                        return json(res, 402, { error: "insufficient channel balance" } satisfies ApiError);
      if (BigInt(ch.spent) + amount > BigInt(ch.lifetimeCap)) return json(res, 400, { error: "lifetime cap reached" } satisfies ApiError);

      const { settleHash, settledAmount, updated } = await enqueueWrite(async () => {
        await assertLoopbackChain(); // [S3]
        const requestId   = `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`;
        const chainNow    = await chainBlockTimestamp();                  // [S7]
        const deadlineSec = chainNow + 300n;
        const signature   = await signVoucher(escrowAddress, channelId, requestId, units, deadlineSec);

        const settleHash = await makeWallet(providerAccount).writeContract({
          address: escrowAddress, abi: ESCROW_ABI, functionName: "settleUsage",
          args: [channelId, requestId, units, deadlineSec, signature],
        });
        const receipt = await pub.waitForTransactionReceipt({ hash: settleHash });
        requireSuccess(receipt, "demo/complete settle"); // [S4]

        // [S6] Decode amount from event — no fallback to request amount.
        let settledAmount: bigint | undefined;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
            if (decoded.eventName === "UsageSettled") {
              settledAmount = (decoded.args as { amount: bigint }).amount; break;
            }
          } catch { /* skip */ }
        }
        if (settledAmount === undefined) throw new Error("UsageSettled event not found in demo/complete receipt");

        const updated = await readChannel(pub, escrowAddress, channelId);
        return { settleHash, settledAmount, updated };
      });

      return json(res, 200, {
        prompt,
        units:          units.toString(),           // [S10] string
        amount:         settledAmount.toString(),   // [S10] string — from event
        requestId:      "simulated",
        txHash:         settleHash,
        channelBalance: updated.balance,
        message: `Charged ${units.toString()} unit(s) (${settledAmount.toString()} µUSDC) for "${prompt.slice(0, 40)}${prompt.length > 40 ? "…" : ""}"`,
      });
    }

    return json(res, 404, { error: "not found" } satisfies ApiError);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "internal error";
    console.error("[server] Error:", msg);
    return json(res, 500, { error: msg } satisfies ApiError);
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────

process.on("exit",    () => { anvilProcess?.kill(); });
process.on("SIGINT",  () => { anvilProcess?.kill(); process.exit(0); });
process.on("SIGTERM", () => { anvilProcess?.kill(); process.exit(0); });

// [S1] Bind explicitly to 127.0.0.1 — never 0.0.0.0 or "::"
const httpServer = createServer((req, res) => { void handle(req, res); });
httpServer.listen(SERVER_PORT, LOOPBACK, () => {
  console.log(`[server] Spondion backend listening on http://${LOOPBACK}:${SERVER_PORT}`);
  console.log("[server] Bootstrapping Anvil node…");
});

startAnvilAndDeploy().catch((e) => {
  console.error("[server] Fatal startup error:", e instanceof Error ? e.message : e);
});
