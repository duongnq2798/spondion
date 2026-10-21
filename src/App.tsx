/**
 * Spondion – Prepaid Escrow App
 *
 * Two modes, controlled by build-time env vars:
 *
 *   Demo tab  (VITE_ENABLE_LOCAL_DEMO=true)
 *     Talks to the local Anvil node via the backend API (/api proxy).
 *     No user wallet required. Fixture keys live server-side only.
 *     NOT included in production / static builds — zero server code or fixture
 *     keys in the browser bundle when this flag is absent.
 *
 *   Wallet tab  (always present)
 *     User connects their own wallet and interacts with a configured deployed
 *     escrow on the network set via VITE_CHAIN_ID / VITE_ESCROW_ADDRESS.
 *     Works independently: never polls the local backend.
 *     Shows an honest "Unconfigured" state when VITE_ESCROW_ADDRESS is empty.
 */

import { lazy, Suspense, useEffect, useState, useCallback } from "react";
import WalletView from "./components/WalletView";
import { type Channel, type Settlement } from "./types";

// ── Feature flags ─────────────────────────────────────────────────────────────

const ENABLE_LOCAL_DEMO = import.meta.env.VITE_ENABLE_LOCAL_DEMO === "true";

// Lazy import DemoView only when the flag is on — ensures child_process / Anvil
// code never enters the static-build bundle when VITE_ENABLE_LOCAL_DEMO=false.
const DemoView = ENABLE_LOCAL_DEMO
  ? lazy(() => import("./components/DemoView"))
  : null;

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "demo" | "wallet";

export interface AppState {
  channels: Channel[];
  providerCredit: Record<string, string>; // decimal string per payout
  settlements: Settlement[];
  loading: boolean;
  error: string | null;
  nodeReady: boolean;
  escrowAddress: string;
  usdcAddress: string;
  rpcUrl: string;
  fixture?: { owner: string; provider: string; payout: string };
}

interface ApiStatusResponse {
  ready: boolean;
  chainId?: number;
  escrow?: string;
  usdc?: string;
  rpcUrl?: string;
  fixture?: { owner: string; provider: string; payout: string };
}

interface ApiListResponse {
  channels: Channel[];
  providerCredit: Record<string, string>;
  settlements: Settlement[];
}

// ── Google Fonts ──────────────────────────────────────────────────────────────
const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href =
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&display=swap";
document.head.appendChild(fontLink);

const API = "/api";

// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  const defaultTab: Tab = ENABLE_LOCAL_DEMO ? "demo" : "wallet";
  const [tab, setTab] = useState<Tab>(defaultTab);

  const [demoState, setDemoState] = useState<AppState>({
    channels: [],
    providerCredit: {},
    settlements: [],
    loading: ENABLE_LOCAL_DEMO,
    error: null,
    nodeReady: false,
    escrowAddress: "",
    usdcAddress: "",
    rpcUrl: "",
  });

  // Poll the local backend — only when demo is enabled
  const refreshDemoState = useCallback((): void => {
    if (!ENABLE_LOCAL_DEMO) return;

    fetch(`${API}/status`)
      .then((r) => (r.ok ? (r.json() as Promise<ApiStatusResponse>) : Promise.reject(new Error(`API ${r.status}`))))
      .then((status) => {
        if (!status.ready) {
          setDemoState((s) => ({ ...s, loading: true, nodeReady: false, error: "Node starting…" }));
          return;
        }
        setDemoState((s) => ({
          ...s,
          nodeReady: true,
          escrowAddress: status.escrow ?? "",
          usdcAddress:   status.usdc   ?? "",
          rpcUrl:        status.rpcUrl ?? "",
          fixture:       status.fixture,
          error: null,
        }));

        fetch(`${API}/channels`)
          .then((r) => (r.ok ? (r.json() as Promise<ApiListResponse>) : Promise.reject(new Error(`API ${r.status}`))))
          .then((data) => {
            setDemoState((s) => ({
              ...s,
              channels:       data.channels,
              providerCredit: data.providerCredit,
              settlements:    data.settlements,
              loading: false,
            }));
          })
          .catch((e: unknown) => {
            setDemoState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : "List error" }));
          });
      })
      .catch((e: unknown) => {
        setDemoState((s) => ({
          ...s,
          loading: false,
          nodeReady: false,
          error: e instanceof Error ? e.message : "Server unreachable — run: bun run server",
        }));
      });
  }, []);

  useEffect(() => {
    if (!ENABLE_LOCAL_DEMO) return;
    refreshDemoState();
    const id = setInterval(refreshDemoState, 3000);
    return () => clearInterval(id);
  }, [refreshDemoState]);

  const visibleTabs: Tab[] = ENABLE_LOCAL_DEMO ? ["demo", "wallet"] : ["wallet"];

  return (
    <div className="min-h-dvh bg-slate-50" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1
              className="text-xl font-bold text-slate-900"
              style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "-0.02em" }}
            >
              Spondion
            </h1>
            <p className="text-xs text-slate-500 -mt-0.5">
              Prepaid Escrow{ENABLE_LOCAL_DEMO ? " · Local Demo" : " · Wallet Mode"}
            </p>
          </div>
          {ENABLE_LOCAL_DEMO && (
            <div className="flex items-center gap-2">
              <StatusDot loading={demoState.loading} error={demoState.error} ready={demoState.nodeReady} />
              <span className="text-xs text-slate-500 tabular-nums">
                {demoState.channels.length} ch
              </span>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Demo-mode status banners */}
        {ENABLE_LOCAL_DEMO && demoState.error && !demoState.nodeReady && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-700">
            {demoState.error}
          </div>
        )}
        {ENABLE_LOCAL_DEMO && demoState.nodeReady && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-xs text-emerald-800 font-mono space-y-0.5">
            <div><strong>Anvil chainId 31337</strong> · escrow: {demoState.escrowAddress.slice(0, 10)}…</div>
            <div>usdc: {demoState.usdcAddress.slice(0, 10)}… · rpc: {demoState.rpcUrl}</div>
          </div>
        )}

        {/* Tabs — only show selector when multiple tabs exist */}
        {visibleTabs.length > 1 && (
          <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
            {visibleTabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
                  tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {t === "demo" ? "Demo (Anvil)" : "Wallet (EIP-1193)"}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        {tab === "demo" && ENABLE_LOCAL_DEMO && DemoView && (
          <Suspense fallback={<div className="py-8 text-center text-slate-400 text-sm">Loading demo…</div>}>
            <DemoView appState={demoState} onRefresh={refreshDemoState} />
          </Suspense>
        )}
        {tab === "wallet" && <WalletView />}
      </main>
    </div>
  );
}

function StatusDot({ loading, error, ready }: { loading: boolean; error: string | null; ready: boolean }) {
  if (error && !ready) return <span className="w-2 h-2 rounded-full bg-red-500 inline-block" title={error} />;
  if (loading && !ready) return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse inline-block" title="Starting…" />;
  return <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" title="Anvil ready" />;
}
