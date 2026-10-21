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
import { ArrowRight, ArrowUpRight, BookOpen, Code2, Cpu, FlaskConical, LayoutDashboard, LockKeyhole, ShieldCheck, Wallet } from "lucide-react";

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
  "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap";
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

  return (
    <div className="spondion-app">
      <a className="skip-link" href="#workspace">Skip to workspace</a>
      <aside className="app-sidebar" aria-label="Main navigation">
        <a href="#" className="brand" aria-label="Spondion home">
          <BrandMark />
          <span className="brand-name">spondion<span className="brand-period">.</span></span>
        </a>
        <div className="sidebar-workspace"><span className="workspace-monogram">S</span><span>Developer workspace<small>Prepaid payments</small></span></div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="primary-nav">
          <button className={`nav-item ${tab === "wallet" ? "active" : ""}`} onClick={() => setTab("wallet")} aria-current={tab === "wallet" ? "page" : undefined} title="Overview"><LayoutDashboard size={18}/><span>Overview</span><span className="nav-active-mark" /></button>
          {ENABLE_LOCAL_DEMO && <button className={`nav-item ${tab === "demo" ? "active" : ""}`} onClick={() => setTab("demo")} aria-current={tab === "demo" ? "page" : undefined} title="Local sandbox"><FlaskConical size={18}/><span>Local sandbox</span></button>}
        </nav>
        <div className="sidebar-label resources-label">RESOURCES</div>
        <nav className="resource-nav" aria-label="Project resources">
          <a className="nav-item" href="https://github.com/duongnq2798/spondion#readme" target="_blank" rel="noopener noreferrer" title="Documentation"><BookOpen size={18}/><span>Documentation</span><ArrowUpRight size={13} className="external-icon"/></a>
          <a className="nav-item" href="https://github.com/duongnq2798/spondion" target="_blank" rel="noopener noreferrer" title="Source code"><Code2 size={18}/><span>Source code</span><ArrowUpRight size={13} className="external-icon"/></a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-callout"><div className="sidebar-callout-icon"><ShieldCheck size={19}/></div><strong>Your budget. Your rules.</strong><p>Authorize each charge.<br/>Keep control of the rest.</p><a href="https://github.com/duongnq2798/spondion/blob/main/docs/architecture.md" target="_blank" rel="noopener noreferrer">Explore the protocol <ArrowUpRight size={14}/></a></div>
          <div className="sidebar-footer"><span className="status-dot"/><span>Built on Arc</span><span className="version-label">v0.1</span></div>
        </div>
      </aside>

      <div className="app-main">
        <header className="workspace-header"><div className="header-context"><a className="compact-wordmark" href="#">spondion<span>.</span></a><div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-separator">/</span><strong>{tab === "demo" ? "Local sandbox" : "Overview"}</strong></div></div><div className="header-meta"><a className="network-pill" href="https://explorer.arc.io" target="_blank" rel="noopener noreferrer"><span className="arc-network-mark">∩</span>Arc Mainnet<ArrowUpRight size={12}/></a><span className="preview-badge">MVP Preview</span></div></header>

        <main className="workspace-main">
          <div className="page-heading"><div><p className="eyebrow">PAYMENTS WORKSPACE</p><h1>{tab === "demo" ? "Your payment sandbox" : "A smarter way to pay for AI"}</h1><p className="page-description">Prepaid USDC. Clear spending limits. Every request accounted for.</p></div><span className="page-date">Spondion / 001</span></div>

          <section className="product-hero" aria-label="How Spondion payments work">
            <div className="hero-copy"><div className="hero-label"><span className="hero-label-dot"/>PROGRAMMABLE PREPAID PAYMENTS</div><h2>Prepay for AI.<br/><span>Stay in control.</span></h2><p>Set a budget, authorize usage, and take back what you don’t spend. One simple USDC payment flow.</p><div className="hero-bottom"><span className="usdc-symbol">$</span><span>Powered by USDC</span><span className="hero-bottom-divider"/><span>Built on Arc</span></div></div>
            <div className="payment-visual" role="img" aria-label="An agent wallet funds an escrow. Authorized usage credits the service provider. Unused funds return to the wallet.">
              <div className="flow-endpoint flow-sender"><span className="flow-icon"><Wallet size={18}/></span><span>Agent wallet<small>Prepaid budget</small></span><span className="flow-mini-tag">YOU</span></div>
              <div className="flow-connector"><span/><span>Fund with USDC</span><ArrowRight size={13}/></div>
              <div className="escrow-visual"><div className="escrow-brand"><span className="escrow-mark"><BrandMark/></span><span>Spondion escrow<small>Funds held by the contract</small></span><LockKeyhole size={16}/></div><div className="escrow-controls"><span><ShieldCheck size={13}/>Signed usage</span><span>Spending limits</span></div></div>
              <div className="flow-connector"><span/><span>Settle authorized usage</span><ArrowRight size={13}/></div>
              <div className="flow-endpoint flow-recipient"><span className="flow-icon"><Cpu size={18}/></span><span>AI service provider<small>Earns on approved usage</small></span><span className="flow-mini-tag">API</span></div>
              <span className="flow-caption">Unused balance stays refundable <ArrowUpRight size={12}/></span>
            </div>
          </section>

          <div className="workspace-section-heading"><div><span className="section-kicker">LET’S GET STARTED</span><h2>{tab === "demo" ? "Test the complete payment flow" : "Your payment workspace"}</h2></div><span className="section-note">{tab === "demo" ? "Local USDC only" : "Connect. Authorize. Settle."}</span></div>

          {ENABLE_LOCAL_DEMO && tab === "demo" && <div className={`sandbox-status ${demoState.nodeReady ? "ready" : ""}`}><StatusDot loading={demoState.loading} error={demoState.error} ready={demoState.nodeReady}/><div><strong>{demoState.nodeReady ? "Local network ready" : "Starting local network"}</strong><span>{demoState.error && !demoState.nodeReady ? demoState.error : "Anvil 31337 · Mock USDC · No user wallet required"}</span></div><span className="sandbox-channel-count">{demoState.channels.length} channels</span></div>}

          <div id="workspace" className="workspace-content">
        {tab === "demo" && ENABLE_LOCAL_DEMO && DemoView && (
          <Suspense fallback={<div className="loading-panel">Loading your sandbox…</div>}>
            <DemoView appState={demoState} onRefresh={refreshDemoState} />
          </Suspense>
        )}
        {tab === "wallet" && <WalletView />}
          </div>

          <footer className="workspace-footer"><span>Spondion · Programmable payments for AI services</span><a href="https://studio.arc.io/app/5c8fa387-6104-4492-bce0-d9b93a71b81a" target="_blank" rel="noopener noreferrer">View Arc Studio project<ArrowUpRight size={13}/></a></footer>
        </main>
      </div>
    </div>
  );
}

function BrandMark() {
  return <svg className="brand-mark" width="31" height="31" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect width="32" height="32" rx="10" fill="currentColor"/><path d="M22 10H14a4 4 0 0 0 0 8h4a2 2 0 0 1 0 4H10M10 22h8a4 4 0 0 0 0-8h-4a2 2 0 0 1 0-4h8" stroke="#D8F3A3" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function StatusDot({ loading, error, ready }: { loading: boolean; error: string | null; ready: boolean }) {
  if (error && !ready) return <span className="w-2 h-2 rounded-full bg-red-500 inline-block" title={error} />;
  if (loading && !ready) return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse inline-block" title="Starting…" />;
  return <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" title="Anvil ready" />;
}
