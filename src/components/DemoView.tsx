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
    Active:  "border-[#d5e7d9] bg-[#edf6ee] text-[#17694d]",
    Closing: "border-[#e2e8cc] bg-[#f7f9ed] text-[#78844a]",
    Closed:  "border-[#e4e8e3] bg-[#f4f6f3] text-[#8a958b]",
  };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-medium ${cls[state] ?? cls.Active}`}>{state}</span>;
}

function TxLink({ hash }: { hash: string }) {
  return (
    <code className="block min-w-0 truncate text-[10px] text-[#92a08f]" title={hash}>
      {hash.slice(0, 12)}…{hash.slice(-6)}
    </code>
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
      <div className="demo-workspace">
        <section className="rounded-2xl border border-[#e0e7e2] bg-white px-6 py-10 sm:px-10">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#edf5ee] text-[#17694d]"><Clock size={23} /></div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#668075]">Local playground</p>
          <h2 className="text-2xl font-semibold tracking-tight text-[#132c25]">Bring your sandbox online.</h2>
          <p className="mt-3 max-w-lg text-sm leading-6 text-[#718078]">Start the local backend to explore a full payment lifecycle with test USDC. No wallet or real funds are needed.</p>
          <div className="mt-6 inline-flex items-center gap-3 rounded-xl border border-[#e3e9e5] bg-[#f5f6f8] px-4 py-3">
            <span className="text-[#849189]" aria-hidden="true">$</span><code className="text-sm text-[#132c25]">bun run server</code>
          </div>
          <p className="mt-6 text-xs leading-5 text-[#849189]">Anvil · Chain 31337 · Real local EIP-712 signing · Mocked AI word-count metering</p>
        </section>
      </div>
    );
  }

  return (
    <div className="demo-workspace space-y-6 text-[#132c25]">
      <section className="overflow-hidden rounded-2xl border border-[#dce5de] bg-white">
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#17694d]"><span className="h-1.5 w-1.5 rounded-full bg-[#17694d]" />Local Anvil · 31337</div>
            <h2 className="text-xl font-semibold tracking-tight">Test the complete payment flow.</h2>
            <p className="mt-1.5 max-w-xl text-xs leading-5 text-[#738078]">Test USDC, real local signatures and receipts. AI output is mocked; word count supplies simulated usage.</p>
          </div>
          <span className="self-start whitespace-nowrap rounded-full bg-[#d8f3a3] px-3 py-1.5 text-[11px] font-semibold text-[#33532d] sm:self-center">No real funds</span>
        </div>
        <div className="border-t border-[#e8ede9] bg-[#fafbf9] px-5 py-3 sm:px-6">
          <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#849087]">Local escrow</span>
            <code className="truncate text-[11px] text-[#55695d]" title={escrowAddress}>{escrowAddress}</code>
          </div>
          {lastTx && <div className="mt-2 flex min-w-0 items-center gap-4"><span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#849087]">Latest receipt</span><TxLink hash={lastTx} /></div>}
        </div>
      </section>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Card step="01" icon={<Plus size={17} />} title="Fund a channel" description="Choose the limits for your local test balance.">
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            {([
              ["pricePerUnit", "Price per unit"],
              ["perCallCap", "Per-call limit"],
              ["lifetimeCap", "Channel limit"],
              ["initialDeposit", "Starting deposit"],
            ] as [keyof typeof DEFAULTS, string][]).map(([key, label]) => (
              <label key={key} className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs font-medium text-[#52665a]">{label}</span>
                <div className="relative">
                  <input type="text" inputMode="numeric" pattern="\d*"
                    className={`${FIELD_CLASS} pr-16 tabular-nums`}
                    value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value.replace(/\D/g, "") || "0" }))}
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[10px] text-[#8b968f]">µUSDC</span>
                </div>
                <span className="text-[11px] tabular-nums text-[#8a958e]">{microToDisplay(form[key])} USDC</span>
              </label>
            ))}
          </div>
          <button onClick={handleOpenChannel} disabled={busy} className={`${PRIMARY_BUTTON} mt-5 w-full`}>
            <Plus size={15} />{busy ? "Submitting…" : "Open & fund channel"}
          </button>
          <p className="mt-3 text-center text-[10px] text-[#8a958e]">Contract transactions execute on your local fixture chain.</p>
        </Card>

        <Card step="02" icon={<Zap size={17} />} title="Sign & settle usage" description="Authorize a request, then settle its voucher on-chain.">
          <div className="space-y-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[#52665a]">Active channel</span>
              <select className={FIELD_CLASS} value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                <option value="">Select a channel</option>
                {activeChannels.map((c) => <option key={c.channelId} value={c.channelId}>#{c.channelId} · {microToDisplay(c.balance)} USDC available</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[#52665a]">Usage units</span>
              <input type="text" inputMode="numeric" pattern="\d*"
                max={selected ? String(BigInt(selected.perCallCap) / BigInt(selected.pricePerUnit)) : "10"}
                className={`${FIELD_CLASS} tabular-nums`} value={units}
                onChange={(e) => setUnits(e.target.value.replace(/\D/g, "") || "1")}
              />
            </label>
            {selected && units && <div className="flex items-center justify-between rounded-xl bg-[#f5f7f4] px-3 py-2.5 text-xs"><span className="text-[#748178]">Request cost</span><span className="font-semibold tabular-nums">{(() => { try { return microToDisplay((parseUint256Strict(units, "Units", 1n) * BigInt(selected.pricePerUnit)).toString()); } catch { return "Invalid units"; } })()} USDC</span></div>}
            <div className="grid grid-cols-2 gap-2.5">
              <button onClick={handleRequestVoucher} disabled={busy || !selectedId} className={SECONDARY_BUTTON}>Sign voucher</button>
              <button onClick={handleSettleVoucher} disabled={busy || !lastVoucher} className={PRIMARY_BUTTON}>Settle on-chain<ChevronRight size={14} /></button>
            </div>
            {lastVoucher && <div className="rounded-xl border border-[#dce8d5] bg-[#f5faef] px-3.5 py-3 text-xs">
              <p className="font-semibold text-[#426338]">EIP-712 voucher ready</p>
              <p className="mt-1.5 break-all font-mono text-[10px] text-[#708268]" title={lastVoucher.requestId}>Request {lastVoucher.requestId.slice(0, 22)}…</p>
              <p className="mt-1 text-[11px] text-[#708268]">{lastVoucher.units} unit(s) · expires {new Date(lastVoucher.deadlineMs).toLocaleTimeString()}</p>
            </div>}
          </div>
        </Card>
      </div>

      <Card icon={<ActivityIcon size={17} />} title="Your channels" description="Balances and status read from the local contract."
        action={<button onClick={onRefresh} aria-label="Refresh channel state" className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#e1e8e2] text-[#6a7d70] transition hover:bg-[#f4f7f3] hover:text-[#17694d]"><RefreshCw size={14} /></button>}>
        {channels.length === 0 ? <div className="py-7 text-center"><p className="text-sm font-medium text-[#617469]">No channels yet</p><p className="mt-1 text-xs text-[#95a096]">Open your first channel above to begin.</p></div> :
          <div className="-mx-5 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[570px] border-collapse text-left">
              <thead><tr className="border-b border-[#e9eee9] bg-[#fafbf9] text-[10px] font-medium uppercase tracking-[0.1em] text-[#8c988f]">
                <th className="px-5 py-3 font-medium sm:pl-6">Channel</th><th className="px-3 py-3 font-medium">Available</th><th className="px-3 py-3 font-medium">Settled</th><th className="px-3 py-3 font-medium">Limit</th><th className="px-5 py-3 text-right font-medium sm:pr-6">Actions</th>
              </tr></thead>
              <tbody className="divide-y divide-[#edf0ec]">{channels.map((ch) => <tr key={ch.channelId} className="transition-colors hover:bg-[#fbfcfa]">
                <td className="px-5 py-4 sm:pl-6"><div className="flex items-center gap-2.5"><span className="text-xs font-semibold">#{ch.channelId}</span><StateChip state={ch.state} /></div>{ch.state === "Closing" && <p className="mt-2 text-[10px] text-[#8d956f]">Refund at {new Date(Number(ch.refundAvailableAt) * 1000).toLocaleTimeString()}</p>}</td>
                <td className="px-3 py-4 text-xs font-semibold tabular-nums">{microToDisplay(ch.balance)}<span className="ml-1 text-[9px] font-normal text-[#939d96]">USDC</span></td>
                <td className="px-3 py-4 text-xs tabular-nums text-[#6b7b70]">{microToDisplay(ch.spent)}</td>
                <td className="px-3 py-4 text-xs tabular-nums text-[#6b7b70]">{microToDisplay(ch.lifetimeCap)}</td>
                <td className="px-5 py-4 sm:pr-6"><div className="flex flex-wrap justify-end gap-2">
                  {ch.state === "Active" && <button onClick={() => handleClose(ch.channelId)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-[#e1e6df] px-2.5 py-1.5 text-[11px] font-medium text-[#6e7d6a] transition hover:bg-[#f4f7ef] disabled:opacity-40"><XCircle size={12} />Close</button>}
                  {ch.state === "Closing" && <><button onClick={() => handleSkipTime(ch.channelId)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-[#e1e6df] px-2.5 py-1.5 text-[11px] font-medium text-[#6e7d6a] transition hover:bg-[#f4f7ef] disabled:opacity-40"><Clock size={12} />Advance time</button><button onClick={() => handleRefund(ch.channelId)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-[#edf5ee] px-2.5 py-1.5 text-[11px] font-semibold text-[#17694d] transition hover:bg-[#e0eddf] disabled:opacity-40">Refund<ChevronRight size={12} /></button></>}
                </div></td>
              </tr>)}</tbody>
            </table>
          </div>}
      </Card>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Card step="03" icon={<Zap size={17} />} title="Meter a demo request" description="Try automatic word-count measurement and settlement.">
          <div className="space-y-4">
            <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-[#52665a]">Active channel</span>
              <select className={FIELD_CLASS} value={selectedId} onChange={(e) => setSelectedId(e.target.value)}><option value="">Select a channel</option>{activeChannels.map((c) => <option key={c.channelId} value={c.channelId}>#{c.channelId} · {microToDisplay(c.balance)} USDC</option>)}</select>
            </label>
            <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-[#52665a]">Sample prompt</span><input className={FIELD_CLASS} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
            <p className="text-[11px] leading-5 text-[#8a968d]">Mocked AI output. Prompt words determine usage, capped by the channel's per-call limit. Signing and settlement execute on local Anvil.</p>
            <button onClick={handleDemoComplete} disabled={busy || !selectedId} className={`${PRIMARY_BUTTON} w-full`}><Zap size={14} />{busy ? "Processing…" : "Measure & settle request"}</button>
          </div>
        </Card>

        <Card step="04" icon={<Download size={17} />} title="Collect provider credit" description="Withdraw settled earnings to the fixture payout.">
          <div className="space-y-4">
            <div className="flex items-end justify-between border-b border-[#e8ede8] pb-4"><div><p className="text-[11px] text-[#849087]">Accrued credit · all payouts</p><p className="mt-1.5 text-3xl font-semibold tracking-tight tabular-nums">{microToDisplay(totalCredit)}<span className="ml-2 text-xs font-medium tracking-normal text-[#8a968d]">USDC</span></p></div><div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#edf5ee] text-[#17694d]"><Download size={17} /></div></div>
            {Object.entries(providerCredit).filter(([, v]) => v !== "0").map(([addr, c]) => <div key={addr} className="flex items-center justify-between gap-3 text-[11px]"><span className="truncate font-mono text-[#7f8f82]" title={addr}>{addr.slice(0, 10)}…{addr.slice(-6)}</span><span className="shrink-0 font-medium tabular-nums text-[#4b6856]">{microToDisplay(c)} USDC</span></div>)}
            <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-[#52665a]">Fixture payout address</span><input className={`${FIELD_CLASS} font-mono text-[11px]`} value={withdrawPayout} onChange={(e) => setWithdrawPayout(e.target.value)} /></label>
            <button onClick={handleWithdraw} disabled={busy || (providerCredit[withdrawPayout] ?? "0") === "0"} className={`${PRIMARY_BUTTON} w-full`}><Download size={14} />Withdraw credit</button>
          </div>
        </Card>
      </div>

      <SettlementLog settlements={settlements} />
    </div>
  );
}

const FIELD_CLASS = "demo-input h-11 w-full rounded-xl border border-[#dfe6e0] bg-white px-3 text-sm text-[#1c392b] transition placeholder:text-[#a2aca4] focus:border-[#639878] focus:outline-none focus:ring-2 focus:ring-[#17694d]/10";
const PRIMARY_BUTTON = "demo-primary inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#17694d] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-[#11573e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17694d] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
const SECONDARY_BUTTON = "demo-secondary inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#dce5dc] bg-white px-4 py-2.5 text-xs font-semibold text-[#17694d] transition hover:bg-[#f2f7f0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17694d] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40";

function Card({ icon, title, description, step, children, action }: {
  icon: React.ReactNode; title: string; description?: string; step?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <section className="demo-panel min-w-0 overflow-hidden rounded-2xl border border-[#e0e7e1] bg-white shadow-[0_2px_5px_rgba(19,44,37,0.02)]">
      <div className="flex items-center gap-3 border-b border-[#e8ede8] px-5 py-4 sm:px-6">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#e1e9dc] bg-[#f4f8ef] text-[#527842]" aria-hidden="true">{step ? <span className="text-xs font-semibold tabular-nums">{step}</span> : icon}</span>
        <div className="min-w-0"><h2 className="text-sm font-semibold tracking-tight text-[#132c25]">{title}</h2>{description && <p className="mt-0.5 text-[11px] leading-4 text-[#8a968d]">{description}</p>}</div>
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </div>
      <div className="px-5 py-5 sm:px-6">{children}</div>
    </section>
  );
}

function SettlementLog({ settlements }: { settlements: Settlement[] }) {
  return (
    <Card icon={<ActivityIcon size={17} />} title="Settlement activity" description="Usage recorded by the local contract."
      action={<span className="rounded-full border border-[#e1e8df] px-2.5 py-1 text-[10px] font-medium tabular-nums text-[#758772]">{settlements.length} settled</span>}>
      {settlements.length === 0 ? <div className="py-6 text-center"><p className="text-sm font-medium text-[#617469]">No settlements yet</p><p className="mt-1 text-xs text-[#95a096]">A settled request will appear here with its transaction receipt.</p></div> :
        <div className="-mx-5 max-h-80 overflow-auto sm:-mx-6"><table className="w-full min-w-[540px] border-collapse text-left">
          <thead className="sticky top-0 bg-[#fafbf9]"><tr className="border-b border-[#e9eee9] text-[10px] uppercase tracking-[0.1em] text-[#8c988f]"><th className="px-5 py-3 font-medium sm:pl-6">Channel / request</th><th className="px-3 py-3 font-medium">Units</th><th className="px-3 py-3 font-medium">Amount</th><th className="px-5 py-3 font-medium sm:pr-6">Local transaction</th></tr></thead>
          <tbody className="divide-y divide-[#edf0ec]">{[...settlements].reverse().map((s, i) => <tr key={`${s.requestId}-${i}`} className="hover:bg-[#fbfcfa]"><td className="px-5 py-3.5 sm:pl-6"><p className="text-xs font-medium text-[#3a5745]">Channel #{s.channelId}</p><p className="mt-1 font-mono text-[10px] text-[#98a295]" title={s.requestId}>{s.requestId.slice(0, 14)}…</p></td><td className="px-3 py-3.5 text-xs tabular-nums text-[#71816f]">{s.units}</td><td className="px-3 py-3.5 text-xs font-semibold tabular-nums text-[#17694d]">+{microToDisplay(s.amount)}<span className="ml-1 text-[9px] font-normal text-[#8a9985]">USDC</span></td><td className="px-5 py-3.5 sm:pr-6"><TxLink hash={s.txHash} /></td></tr>)}</tbody>
        </table></div>}
    </Card>
  );
}
