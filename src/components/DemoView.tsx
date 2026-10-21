/**
 * DemoView — talks to the local Anvil node via the backend API.
 *
 * No user wallet required. Fixture keys live server-side only.
 * EIP-712 signing is done by the server using the owner fixture key.
 * All contract state is read from real chain state (not in-memory).
 * Amounts are kept as decimal integer strings throughout — no Number() coercion.
 */

import { useState } from "react";
import { Plus, Zap, XCircle, ChevronRight, RefreshCw, Download, Clock, ActivityIcon } from "lucide-react";
import { toast } from "sonner";
import { type AppState } from "../App";
import { type Channel, type Settlement, microToDisplay } from "../types";
import { parseUint256Strict } from "../lib/validation";
import { api } from "../lib/api";

interface Props {
  appState: AppState;
  onRefresh: () => void;
}

// Default channel parameters (decimal integer strings as required by the server)
const DEFAULTS = {
  pricePerUnit:   "1000",
  perCallCap:     "10000",
  lifetimeCap:    "100000",
  initialDeposit: "50000",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function StateChip({ state }: { state: Channel["state"] }) {
  const cls: Record<string, string> = {
    Active:  "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    Closing: "bg-amber-50  text-amber-700  ring-1 ring-amber-200",
    Closed:  "bg-slate-100 text-slate-500  ring-1 ring-slate-200",
  };
  return <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${cls[state] ?? cls.Active}`}>{state}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className="text-xs font-medium text-slate-700 tabular-nums">{value}</p>
    </div>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <p className="text-[10px] font-mono text-slate-400 truncate" title={hash}>
      tx: {hash.slice(0, 18)}…
    </p>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DemoView({ appState, onRefresh }: Props) {
  const { channels, providerCredit, settlements, nodeReady, escrowAddress } = appState;

  const [form, setForm]             = useState(DEFAULTS);
  const [selectedId, setSelectedId] = useState<string>("");
  const [units, setUnits]           = useState("3");  // kept as string
  const [prompt, setPrompt]         = useState("What is the capital of France?");
  const [lastVoucher, setLastVoucher] = useState<{
    channelId: string; requestId: string; units: string;
    deadline: string; deadlineMs: number; signature: string;
  } | null>(null);
  const [lastTx, setLastTx]         = useState<string>("");
  const [busy, setBusy]             = useState(false);
  const [withdrawPayout, setWithdrawPayout] = useState(appState.fixture?.payout ?? "");

  // sync payout from appState once ready
  if (appState.nodeReady && appState.fixture && withdrawPayout === "") {
    setWithdrawPayout(appState.fixture.payout);
  }

  const activeChannels = channels.filter((c) => c.state === "Active");
  const selected       = channels.find((c) => c.channelId === selectedId);

  function withBusy(fn: () => Promise<void>): () => void {
    return () => {
      setBusy(true);
      fn().catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : "Error");
      }).finally(() => setBusy(false));
    };
  }

  const handleOpenChannel = withBusy(async () => {
    const r = await api.openChannel(form);
    toast.success(`Channel #${r.channel.channelId} opened — tx ${r.txHash?.slice(0, 10)}…`);
    setLastTx(r.txHash ?? "");
    onRefresh();
  });

  const handleRequestVoucher = withBusy(async () => {
    if (!selectedId) { toast.error("Select a channel first"); return; }
    const r = await api.requestVoucher(selectedId, units);
    setLastVoucher(r.voucher);
    toast.success(`EIP-712 voucher issued — signed by ${r.signedBy.slice(0, 10)}…`);
  });

  const handleSettleVoucher = withBusy(async () => {
    if (!lastVoucher) return;
    const r = await api.settle(lastVoucher.channelId, lastVoucher);
    toast.success(`Settled ${r.settlement.units} unit(s) — block ${r.blockNumber}`);
    setLastTx(r.txHash);
    setLastVoucher(null);
    onRefresh();
  });

  const handleDemoComplete = withBusy(async () => {
    if (!selectedId) { toast.error("Select a channel first"); return; }
    const r = await api.demoComplete(selectedId, prompt);
    toast.success(r.message);
    setLastTx(r.txHash);
    onRefresh();
  });

  const handleClose = (id: string) => withBusy(async () => {
    const r = await api.requestClose(id);
    toast.success(`Closing #${id} — grace until ${new Date(Number(r.refundAvailableAt) * 1000).toLocaleTimeString()}`);
    setLastTx(r.txHash);
    onRefresh();
  })();

  const handleSkipTime = (id: string) => withBusy(async () => {
    const r = await api.skipTime(id);
    toast.success(r.message);
    onRefresh();
  })();

  const handleRefund = (id: string) => withBusy(async () => {
    const r = await api.finalizeRefund(id);
    toast.success(`Refunded ${microToDisplay(r.refunded)} USDC — tx ${r.txHash.slice(0, 10)}…`);
    setLastTx(r.txHash);
    onRefresh();
  })();

  const handleWithdraw = withBusy(async () => {
    const r = await api.withdraw(withdrawPayout || undefined);
    toast.success(`Withdrew ${microToDisplay(r.withdrawn)} USDC — tx ${r.txHash.slice(0, 10)}…`);
    setLastTx(r.txHash);
    onRefresh();
  });

  // Total credit is sum of all string values
  const totalCredit = Object.values(providerCredit).reduce((a, b) => {
    try { return (BigInt(a) + BigInt(b)).toString(); } catch { return a; }
  }, "0");

  if (!nodeReady) {
    return (
      <div className="bg-white/70 rounded-2xl border border-slate-200/80 shadow-sm p-8 text-center text-slate-500 text-sm">
        Waiting for Anvil node… run{" "}
        <code className="bg-slate-100 px-1 rounded">bun run server</code> in a terminal.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Escrow info */}
      <div className="bg-slate-900 text-slate-300 rounded-xl px-4 py-3 text-xs font-mono space-y-0.5">
        <p><span className="text-slate-500">escrow</span> {escrowAddress}</p>
        {lastTx && <p><span className="text-slate-500">last tx</span> {lastTx}</p>}
      </div>

      {/* ── Open channel ── */}
      <Card icon={<Plus size={15} className="text-blue-600" />} title="Open Channel">
        <div className="grid grid-cols-2 gap-3">
          {([
            ["pricePerUnit",   "Price/unit (µUSDC)"],
            ["perCallCap",     "Per-call cap (µUSDC)"],
            ["lifetimeCap",    "Lifetime cap (µUSDC)"],
            ["initialDeposit", "Initial deposit (µUSDC)"],
          ] as [keyof typeof DEFAULTS, string][]).map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-xs text-slate-500 font-medium">{label}</span>
              <input
                type="text" inputMode="numeric" pattern="\d*"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-400/50"
                value={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value.replace(/\D/g, "") || "0" }))}
              />
            </label>
          ))}
          <div className="col-span-2">
            <button
              onClick={handleOpenChannel} disabled={busy}
              className="w-full rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
            >
              {busy ? "Opening…" : "Open + Deposit (real contract tx)"}
            </button>
          </div>
        </div>
      </Card>

      {/* ── Channel list ── */}
      <Card
        icon={<ActivityIcon size={15} className="text-blue-600" />}
        title="Channels (live chain state)"
        action={<button onClick={onRefresh} className="text-slate-400 hover:text-slate-600"><RefreshCw size={13} /></button>}
      >
        {channels.length === 0
          ? <p className="py-6 text-center text-slate-400 text-sm">No channels yet.</p>
          : (
            <ul className="divide-y divide-slate-100">
              {channels.map((ch) => (
                <li key={ch.channelId} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="font-mono text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">#{ch.channelId}</span>
                        <StateChip state={ch.state} />
                      </div>
                      <div className="grid grid-cols-3 gap-x-4 gap-y-1">
                        <Stat label="Balance"  value={`${microToDisplay(ch.balance)} USDC`} />
                        <Stat label="Spent"    value={`${microToDisplay(ch.spent)} USDC`} />
                        <Stat label="Cap"      value={`${microToDisplay(ch.lifetimeCap)} USDC`} />
                      </div>
                      {ch.state === "Closing" && (
                        <p className="text-[10px] text-amber-600 mt-1">
                          Refund unlocks {new Date(Number(ch.refundAvailableAt) * 1000).toLocaleTimeString()}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0 items-end">
                      {ch.state === "Active" && (
                        <button onClick={() => handleClose(ch.channelId)} disabled={busy}
                          className="flex items-center gap-1 text-xs text-amber-600 hover:text-amber-800 font-medium disabled:opacity-40">
                          <XCircle size={13} /> Close
                        </button>
                      )}
                      {ch.state === "Closing" && (
                        <>
                          <button onClick={() => handleSkipTime(ch.channelId)} disabled={busy}
                            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 font-medium disabled:opacity-40">
                            <Clock size={13} /> Skip grace
                          </button>
                          <button onClick={() => handleRefund(ch.channelId)} disabled={busy}
                            className="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-800 font-medium disabled:opacity-40">
                            <ChevronRight size={13} /> Refund
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Card>

      {/* ── Manual voucher flow ── */}
      <Card icon={<Zap size={15} className="text-blue-600" />} title="Manual Voucher (EIP-712)">
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500 font-medium">Channel</span>
            <select
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/50"
              value={selectedId} onChange={(e) => setSelectedId(e.target.value)}
            >
              <option value="">— select active channel —</option>
              {activeChannels.map((c) => (
                <option key={c.channelId} value={c.channelId}>
                  #{c.channelId} — {microToDisplay(c.balance)} USDC left
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500 font-medium">Units (integer)</span>
            <input
              type="text" inputMode="numeric" pattern="\d*"
              max={selected ? String(BigInt(selected.perCallCap) / BigInt(selected.pricePerUnit)) : "10"}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-400/50"
              value={units}
              onChange={(e) => setUnits(e.target.value.replace(/\D/g, "") || "1")}
            />
          </label>
          {selected && units && (
            <p className="text-xs text-slate-500">
              Cost: {(() => { try { return microToDisplay((parseUint256Strict(units, "Units", 1n) * BigInt(selected.pricePerUnit)).toString()); } catch { return "Invalid units"; } })()} USDC
            </p>
          )}
          <div className="flex gap-2">
            <button onClick={handleRequestVoucher} disabled={busy || !selectedId}
              className="flex-1 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors">
              1. Sign Voucher
            </button>
            <button onClick={handleSettleVoucher} disabled={busy || !lastVoucher}
              className="flex-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors">
              2. Settle On-chain
            </button>
          </div>
          {lastVoucher && (
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-xs space-y-0.5">
              <p className="font-semibold text-blue-700">Pending EIP-712 Voucher</p>
              <p className="font-mono text-blue-600 break-all">reqId: {lastVoucher.requestId.slice(0, 20)}…</p>
              <p className="text-blue-600">{lastVoucher.units} unit(s) · expires {new Date(lastVoucher.deadlineMs).toLocaleTimeString()}</p>
            </div>
          )}
        </div>
      </Card>

      {/* ── Demo complete (AI units) ── */}
      <Card icon={<Zap size={15} className="text-violet-600" />} title="Demo AI Call (auto-measure + settle)">
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500 font-medium">Channel</span>
            <select
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/50"
              value={selectedId} onChange={(e) => setSelectedId(e.target.value)}
            >
              <option value="">— select active channel —</option>
              {activeChannels.map((c) => (
                <option key={c.channelId} value={c.channelId}>
                  #{c.channelId} — {microToDisplay(c.balance)} USDC
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500 font-medium">Prompt (word count = units)</span>
            <input
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/50"
              value={prompt} onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <button onClick={handleDemoComplete} disabled={busy || !selectedId}
            className="w-full rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors">
            {busy ? "Processing…" : "Run Demo AI Call (EIP-712 + real tx)"}
          </button>
        </div>
      </Card>

      {/* ── Withdraw ── */}
      <Card icon={<Download size={15} className="text-blue-600" />} title="Provider Withdraw">
        <div className="space-y-3">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-slate-500">Total credit (all payouts)</span>
            <span className="text-lg font-bold text-slate-900 tabular-nums">
              {microToDisplay(totalCredit)} USDC
            </span>
          </div>
          {Object.entries(providerCredit).filter(([, v]) => v !== "0").map(([addr, c]) => (
            <div key={addr} className="flex justify-between text-xs text-slate-600">
              <span className="font-mono">{addr.slice(0, 18)}…</span>
              <span className="tabular-nums">{microToDisplay(c)} USDC</span>
            </div>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500 font-medium">Payout address (must match fixture)</span>
            <input
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-400/50"
              value={withdrawPayout} onChange={(e) => setWithdrawPayout(e.target.value)}
            />
          </label>
          <button
            onClick={handleWithdraw}
            disabled={busy || (providerCredit[withdrawPayout] ?? "0") === "0"}
            className="w-full rounded-xl bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition-colors"
          >
            Withdraw (real contract tx)
          </button>
        </div>
      </Card>

      {/* ── Settlement log ── */}
      <SettlementLog settlements={settlements} />
    </div>
  );
}

// ── Card wrapper ───────────────────────────────────────────────────────────────

function Card({ icon, title, children, action }: {
  icon: React.ReactNode; title: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="bg-white/70 backdrop-blur-sm rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
        {icon}
        <h2 className="font-semibold text-slate-800 text-sm uppercase tracking-wide" style={{ letterSpacing: "0.06em" }}>{title}</h2>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

// ── Settlement log ─────────────────────────────────────────────────────────────

function SettlementLog({ settlements }: { settlements: Settlement[] }) {
  return (
    <Card icon={<ActivityIcon size={15} className="text-blue-600" />} title={`Settlement Log (${settlements.length})`}>
      {settlements.length === 0
        ? <p className="py-4 text-center text-slate-400 text-sm">No settlements yet.</p>
        : (
          <ul className="divide-y divide-slate-100 max-h-56 overflow-y-auto -mx-5 px-5">
            {[...settlements].reverse().map((s, i) => (
              <li key={`${s.requestId}-${i}`} className="py-2.5 flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-700">Ch#{s.channelId} · {s.units} unit{s.units !== "1" ? "s" : ""}</p>
                  <TxLink hash={s.txHash} />
                </div>
                <p className="text-xs font-semibold text-emerald-700 tabular-nums shrink-0">
                  +{microToDisplay(s.amount)} USDC
                </p>
              </li>
            ))}
          </ul>
        )
      }
    </Card>
  );
}
