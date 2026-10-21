/** Real HTTP-to-EVM regressions. Starts and stops only owned loopback fixtures. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeEventLog, http, parseAbi, type Address } from "viem";
import { anvil } from "viem/chains";

const root = process.env["SPONDION_TEST_APP"] ?? fileURLToPath(new URL("..", import.meta.url));
const ABI = parseAbi([
  "function nextChannelId() view returns (uint256)",
  "function providerCredit(address) view returns (uint256)",
  "event ProviderWithdrawn(address indexed payout, uint256 amount)",
]);
let anvilProcess: ChildProcess | undefined;
let backendProcess: ChildProcess | undefined;
let apiBase = "";
let rpcUrl = "";
let escrow: Address;
let payout: Address;
let channelId = "";
let pub: ReturnType<typeof createPublicClient>;
let startupLog = "";

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("No loopback port");
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function request(path: string, body?: Record<string, unknown>) {
  if (!apiBase.startsWith("http://127.0.0.1:")) throw Error("Loopback only");
  const response = await fetch(apiBase + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, data: await response.json() as Record<string, any> };
}

async function rpc(method: string, params: unknown[] = []) {
  if (!rpcUrl.startsWith("http://127.0.0.1:")) throw Error("Loopback only");
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(1000),
  });
  const data = await response.json() as { result?: unknown; error?: unknown };
  if (data.error) throw Error(JSON.stringify(data.error));
  return data.result;
}

beforeAll(async () => {
  const rpcPort = await freePort();
  const apiPort = await freePort();
  rpcUrl = `http://127.0.0.1:${rpcPort}`;
  apiBase = `http://127.0.0.1:${apiPort}`;
  anvilProcess = spawn("anvil", ["--host", "127.0.0.1", "--port", String(rpcPort), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  for (let tries = 0; ; tries++) {
    try { if (await rpc("eth_chainId") === "0x7a69") break; } catch { /* starting */ }
    if (tries > 100) throw Error("Owned Anvil did not start");
    await Bun.sleep(100);
  }
  backendProcess = spawn(process.execPath, ["--no-env-file", "--no-install", "server/index.ts"], {
    cwd: root, env: { ...process.env, ANVIL_PORT: String(rpcPort), SERVER_PORT: String(apiPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backendProcess.stdout?.on("data", data => { startupLog += data.toString(); });
  backendProcess.stderr?.on("data", data => { startupLog += data.toString(); });
  for (let tries = 0; ; tries++) {
    if (backendProcess.exitCode !== null) throw Error(`Backend exited: ${startupLog.slice(-1200)}`);
    try {
      const status = await request("/status");
      if (status.status === 200 && status.data.ready === true) {
        expect(status.data.chainId).toBe(31337);
        expect(status.data.rpcUrl).toBe(rpcUrl);
        escrow = status.data.escrow as Address;
        payout = status.data.fixture.payout as Address;
        break;
      }
    } catch { /* starting */ }
    if (tries > 150) throw Error(`Backend not actually ready: ${startupLog.slice(-1200)}`);
    await Bun.sleep(100);
  }
  pub = createPublicClient({ chain: anvil, transport: http(rpcUrl) });
  expect(await pub.getChainId()).toBe(31337);
  const created = await request("/channels", { pricePerUnit: "1000", perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "50000" });
  expect(created.status).toBe(201);
  channelId = created.data.channel.channelId;
}, 40_000);

afterAll(() => {
  backendProcess?.kill();
  anvilProcess?.kill();
});

describe("decimal strings are mandatory before any write", () => {
  for (const [field, value] of [
    ["pricePerUnit", 1000], ["perCallCap", 10000],
    ["lifetimeCap", 9007199254740992], ["initialDeposit", 0],
  ] as const) {
    test(`rejects numeric JSON ${field} without opening a channel`, async () => {
      const before = await pub.readContract({ address: escrow, abi: ABI, functionName: "nextChannelId" });
      const response = await request("/channels", { pricePerUnit: "1000", perCallCap: "10000", lifetimeCap: "100000", initialDeposit: "0", [field]: value });
      expect(response.status).toBe(400);
      expect(await pub.readContract({ address: escrow, abi: ABI, functionName: "nextChannelId" })).toBe(before);
    });
  }
  test("rejects numeric voucher units instead of coercing them", async () => {
    expect((await request(`/channels/${channelId}/voucher`, { units: 1 })).status).toBe(400);
  });
  test("rejects numeric demo channelId without settling", async () => {
    const before = await pub.getBlockNumber({ cacheTime: 0 });
    expect((await request("/demo/complete", { channelId: Number(channelId), prompt: "one" })).status).toBe(400);
    expect(await pub.getBlockNumber({ cacheTime: 0 })).toBe(before);
  });
  test("rejects numeric settlement units and deadline without a transaction", async () => {
    const voucher = await request(`/channels/${channelId}/voucher`, { units: "1" });
    expect(voucher.status).toBe(200);
    const before = await pub.getBlockNumber({ cacheTime: 0 });
    for (const field of ["units", "deadline"] as const) {
      const response = await request(`/channels/${channelId}/settle`, { ...voucher.data.voucher, [field]: Number(voucher.data.voucher[field]) });
      expect(response.status).toBe(400);
    }
    expect(await pub.getBlockNumber({ cacheTime: 0 })).toBe(before);
  });
});

test("concurrent withdrawals use queued credit and successful receipt event amounts", async () => {
  const settled = await request("/demo/complete", { channelId, prompt: "one" });
  expect(settled.status).toBe(200);
  const credit = await pub.readContract({ address: escrow, abi: ABI, functionName: "providerCredit", args: [payout] });
  expect(credit > 0n).toBe(true);
  const responses = await Promise.all(Array.from({ length: 12 }, () => request("/withdraw", { payout })));
  expect(responses.filter(response => response.status === 200)).toHaveLength(1);
  expect(responses.filter(response => response.status === 400)).toHaveLength(11);
  const response = responses.find(response => response.status === 200)!;
  const receipt = await pub.waitForTransactionReceipt({ hash: response.data.txHash });
  expect(receipt.status).toBe("success");
  const events = receipt.logs.filter(log => log.address.toLowerCase() === escrow.toLowerCase()).flatMap(log => {
    try {
      const decoded = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      return decoded.eventName === "ProviderWithdrawn" ? [decoded] : [];
    } catch { return []; }
  });
  expect(events).toHaveLength(1);
  const event = events[0]!;
  expect(response.data.withdrawn).toBe(event.args.amount.toString());
  expect(response.data.payout.toLowerCase()).toBe(event.args.payout.toLowerCase());
  expect(event.args.amount).toBe(credit);
  expect(await pub.readContract({ address: escrow, abi: ABI, functionName: "providerCredit", args: [payout] })).toBe(0n);
}, 30_000);

test("withdrawal response includes settlements ahead of it in the write queue", async () => {
  expect((await request("/demo/complete", { channelId, prompt: "one" })).status).toBe(200);
  expect(await pub.readContract({ address: escrow, abi: ABI, functionName: "providerCredit", args: [payout] })).toBe(1000n);
  const voucher = await request(`/channels/${channelId}/voucher`, { units: "2" });
  expect(voucher.status).toBe(200);
  async function pendingTransaction() {
    for (let tries = 0; tries < 100; tries++) {
      const pending = await rpc("eth_getBlockByNumber", ["pending", false]) as { transactions: unknown[] };
      if (pending.transactions.length) return;
      await Bun.sleep(20);
    }
    throw Error("Expected owned pending transaction");
  }
  await rpc("evm_setAutomine", [false]);
  try {
    const settlement = request(`/channels/${channelId}/settle`, voucher.data.voucher);
    await pendingTransaction(); // Settlement is queued and cannot yet be mined.
    const withdrawal = request("/withdraw", { payout });
    // Admit the HTTP request while the preceding settlement is still pending.
    await Bun.sleep(100);
    await rpc("evm_mine");
    expect((await settlement).status).toBe(200);
    await pendingTransaction();
    await rpc("evm_mine");
    const response = await withdrawal;
    expect(response.status).toBe(200);
    const receipt = await pub.waitForTransactionReceipt({ hash: response.data.txHash });
    expect(receipt.status).toBe("success");
    const event = receipt.logs.filter(log => log.address.toLowerCase() === escrow.toLowerCase()).flatMap(log => {
      try {
        const decoded = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
        return decoded.eventName === "ProviderWithdrawn" ? [decoded] : [];
      } catch { return []; }
    });
    expect(event).toHaveLength(1);
    expect(event[0]!.args.amount).toBe(3000n); // 1000 prior credit + queued 2 × 1000.
    expect(response.data.withdrawn).toBe("3000");
    expect(response.data.withdrawn).toBe(event[0]!.args.amount.toString());
    expect(response.data.payout.toLowerCase()).toBe(event[0]!.args.payout.toLowerCase());
  } finally {
    await rpc("evm_setAutomine", [true]);
  }
}, 30_000);
