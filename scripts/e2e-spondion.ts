#!/usr/bin/env bun
/**
 * Spondion E2E Integration Test
 *
 * Exercises the demo API server end-to-end without any network deploy,
 * wallet signature, funded transaction, paid API, or submission.
 *
 * Run:   bun run scripts/e2e-spondion.ts
 *
 * Requires the API server to be running:
 *   bun run server
 */

const BASE = process.env.API_BASE ?? "http://localhost:3001";

let passed = 0;
let failed = 0;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ── Test suites ────────────────────────────────────────────────────────────────

async function testHealth(): Promise<void> {
  console.log("\n=== health ===");
  const { status, data } = await req<{ status: string; demo: boolean }>("GET", "/health");
  assert("responds 200", status === 200);
  assert("demo flag set", (data as { demo: boolean }).demo === true);
}

async function testOpenChannel(): Promise<string> {
  console.log("\n=== openChannel ===");

  // Happy path
  const { status, data } = await req<{ channel: { channelId: string; balance: number; state: string } }>(
    "POST",
    "/channels",
    {
      owner: "e2e-owner",
      provider: "e2e-provider",
      payout: "e2e-payout",
      pricePerUnit: 1000,
      perCallCap: 10000,
      lifetimeCap: 100000,
      initialDeposit: 50000,
    }
  );
  assert("status 201", status === 201, `got ${status}`);
  const ch = (data).channel;
  assert("channel id present", typeof ch.channelId === "string");
  assert("initial balance correct", ch.balance === 50000, `got ${ch.balance}`);
  assert("state Active", ch.state === "Active");

  // Missing fields
  const { status: s2 } = await req("POST", "/channels", { owner: "x" });
  assert("rejects missing provider/payout → 400", s2 === 400);

  // Cap mismatch
  const { status: s3 } = await req("POST", "/channels", {
    owner: "x", provider: "y", payout: "z",
    pricePerUnit: 1, perCallCap: 9999, lifetimeCap: 1000,
  });
  assert("rejects cap mismatch → 400", s3 === 400);

  return ch.channelId;
}

async function testVoucherAndSettle(channelId: string): Promise<void> {
  console.log("\n=== voucher + settle ===");

  // Request voucher
  const { status: vs, data: vd } = await req<{ voucher: { requestId: string; units: number; deadline: number; signature: string } }>(
    "POST", `/channels/${channelId}/voucher`, { units: 3 }
  );
  assert("voucher 200", vs === 200, `got ${vs}`);
  const voucher = (vd).voucher;
  assert("voucher has requestId", typeof voucher.requestId === "string");
  assert("voucher units = 3", voucher.units === 3);
  assert("voucher has signature", typeof voucher.signature === "string" && voucher.signature.length > 0);

  // Settle the voucher
  const { status: ss, data: sd } = await req<{
    settlement: { amount: number; units: number };
    channelBalance: number;
  }>("POST", `/channels/${channelId}/settle`, {
    requestId: voucher.requestId,
    units: voucher.units,
    deadline: voucher.deadline,
    signature: voucher.signature,
  });
  assert("settle 200", ss === 200, `got ${ss}`);
  const settlement = (sd);
  assert("settlement amount = 3000", settlement.settlement.amount === 3000, `got ${settlement.settlement.amount}`);
  assert("channel balance decreased", settlement.channelBalance === 47000, `got ${settlement.channelBalance}`);

  // Replay same voucher → must fail
  const { status: rs } = await req("POST", `/channels/${channelId}/settle`, {
    requestId: voucher.requestId,
    units: voucher.units,
    deadline: voucher.deadline,
    signature: voucher.signature,
  });
  assert("replay rejected 400", rs === 400, `got ${rs}`);

  // Invalid signature
  const { status: is } = await req<{ voucher: { requestId: string; units: number; deadline: number; signature: string } }>(
    "POST", `/channels/${channelId}/voucher`, { units: 1 }
  );
  const v2 = (await (await fetch(`${BASE}/channels/${channelId}/voucher`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ units: 1 }),
  })).json()) as { voucher: { requestId: string; units: number; deadline: number } };
  const { status: bads } = await req("POST", `/channels/${channelId}/settle`, {
    requestId: v2.voucher.requestId,
    units: v2.voucher.units,
    deadline: v2.voucher.deadline,
    signature: "deadbeef".repeat(8), // wrong signature
  });
  assert("bad signature rejected 400", bads === 400, `got ${bads}`);
  // need to suppress unused variable warnings
  void is;
}

async function testClose(channelId: string): Promise<void> {
  console.log("\n=== close + refund ===");

  // Request close
  const { status: cs, data: cd } = await req<{ channel: { state: string } }>(
    "POST", `/channels/${channelId}/close`
  );
  assert("close 200", cs === 200, `got ${cs}`);
  assert("state Closing", (cd).channel.state === "Closing");

  // Cannot close again
  const { status: cs2 } = await req("POST", `/channels/${channelId}/close`);
  assert("double close rejected 400", cs2 === 400);

  // Finalize refund
  const { status: rs, data: rd } = await req<{ refunded: number; channel: { state: string } }>(
    "POST", `/channels/${channelId}/refund`
  );
  assert("refund 200", rs === 200, `got ${rs}`);
  // After 3 units settled, 47000 µUSDC should be refunded
  assert("refunded 47000", (rd as { refunded: number }).refunded === 47000, `got ${(rd as { refunded: number }).refunded}`);
  assert("state Closed", (rd as { channel: { state: string } }).channel.state === "Closed");

  // Cannot refund again
  const { status: rs2 } = await req("POST", `/channels/${channelId}/refund`);
  assert("double refund rejected 400", rs2 === 400);
}

async function testWithdraw(): Promise<void> {
  console.log("\n=== withdraw ===");

  // payout-demo should have no credit yet; open and settle first with payout-demo
  const { data: od } = await req<{ channel: { channelId: string } }>("POST", "/channels", {
    owner: "w-owner", provider: "w-provider", payout: "w-payout",
    pricePerUnit: 1000, perCallCap: 10000, lifetimeCap: 100000, initialDeposit: 50000,
  });
  const wid = (od).channel.channelId;

  // Request + settle a voucher
  const { data: vd } = await req<{ voucher: { requestId: string; units: number; deadline: number; signature: string } }>(
    "POST", `/channels/${wid}/voucher`, { units: 5 }
  );
  const v = (vd).voucher;
  await req("POST", `/channels/${wid}/settle`, {
    requestId: v.requestId, units: v.units, deadline: v.deadline, signature: v.signature,
  });

  // Withdraw from w-payout
  const { status: ws, data: wd } = await req<{ withdrawn: number }>("POST", "/withdraw", { payout: "w-payout" });
  assert("withdraw 200", ws === 200, `got ${ws}`);
  assert("withdrew 5000", (wd).withdrawn === 5000, `got ${(wd).withdrawn}`);

  // No credit left
  const { status: ws2 } = await req("POST", "/withdraw", { payout: "w-payout" });
  assert("double withdraw rejected 400", ws2 === 400);

  // Non-existent payout
  const { status: ws3 } = await req("POST", "/withdraw", { payout: "nobody" });
  assert("unknown payout rejected 400", ws3 === 400);
}

async function testChannelList(): Promise<void> {
  console.log("\n=== channel list ===");
  const { status, data } = await req<{ channels: unknown[]; settlements: unknown[] }>("GET", "/channels");
  assert("GET /channels 200", status === 200, `got ${status}`);
  const d = data;
  assert("channels is array", Array.isArray(d.channels));
  assert("settlements is array", Array.isArray(d.settlements));
}

async function testInsufficientBalance(): Promise<void> {
  console.log("\n=== edge: insufficient balance ===");

  const { data: od } = await req<{ channel: { channelId: string } }>("POST", "/channels", {
    owner: "ib-owner", provider: "ib-provider", payout: "ib-payout",
    pricePerUnit: 1000, perCallCap: 10000, lifetimeCap: 100000,
    initialDeposit: 0, // no deposit
  });
  const id = (od).channel.channelId;

  const { status } = await req("POST", `/channels/${id}/voucher`, { units: 1 });
  assert("voucher on empty channel → 402", status === 402, `got ${status}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log(`\nSpondion E2E Test Suite — ${BASE}`);
console.log("=".repeat(48));

try {
  await testHealth();
  const channelId = await testOpenChannel();
  await testVoucherAndSettle(channelId);
  await testClose(channelId);
  await testWithdraw();
  await testChannelList();
  await testInsufficientBalance();
} catch (err) {
  console.error("\nFatal error:", err instanceof Error ? err.message : err);
  failed++;
}

console.log(`\n${"=".repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(48));

if (failed > 0) process.exit(1);
