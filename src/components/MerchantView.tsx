import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleAlert, Clock3, Code2, Database, FileSearch, Fingerprint, History, Loader2, RefreshCw, RotateCcw, Search, ShieldCheck, Terminal } from "lucide-react";
import { displayMerchantAmount, getMerchantOperation, getMerchantOperations, getMerchantSession, MerchantApiError, safeResultUrl, searchMerchant, type MerchantOperation, type MerchantSession } from "../lib/merchant-api";
import "../merchant.css";

const SIGN_IN_URL = "/signin-with-chatgpt?return_to=%2F";
const DOCS_URL = "https://github.com/duongnq2798/spondion/blob/main/docs/MERCHANT-INTEGRATION.md";
const MAX_QUERY_LENGTH = 500;
const MAX_STATUS_CHECKS = 8;
const STATUS_INTERVAL_MS = 2_000;
const DRAFT_STORAGE_KEY = "spondion.merchant-request.v1";
interface SearchRequest { query: string; idempotencyKey: string }

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : "The workspace could not complete this request. Please try again.";
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Status({ status }: { status: MerchantOperation["status"] }) {
  const labels = { succeeded: "Completed", pending: "In progress", unknown: "Needs review", failed: "Failed" };
  return <span className={`merchant-operation-status is-${status}`}><span />{labels[status]}</span>;
}

export default function MerchantView() {
  const [session, setSession] = useState<MerchantSession | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [query, setQuery] = useState("");
  const [lastRequest, setLastRequest] = useState<SearchRequest | null>(null);
  const [operations, setOperations] = useState<MerchantOperation[]>([]);
  const [selected, setSelected] = useState<MerchantOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollLimitReached, setPollLimitReached] = useState(false);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const detailSequence = useRef(0);
  const authGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    // Remove the unscoped draft left by earlier versions; private queries now
    // come only from the signed-in workspace's server-side operation history.
    try { sessionStorage.removeItem(DRAFT_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
    return () => { mounted.current = false; };
  }, []);

  const handleAuthError = useCallback((value: unknown): void => {
    if (value instanceof MerchantApiError && value.status === 401) {
      authGeneration.current += 1;
      detailSequence.current += 1;
      setAuthRequired(true);
      setSession((current) => current ? { ...current, authenticated: false, user: null } : null);
      setOperations([]);
      setSelected(null);
      setQuery("");
      setLastRequest(null);
      setNotice(null);
      setDetailError(null);
      setLoadingDetail(false);
    }
  }, []);

  const refreshHistory = useCallback(async (restoreRequest = false): Promise<void> => {
    const generation = authGeneration.current;
    setRefreshing(true);
    setHistoryError(null);
    try {
      const list = await getMerchantOperations();
      if (!mounted.current || generation !== authGeneration.current) return;
      setOperations(list);
      setSelected((current) => current ? list.find((item) => item.id === current.id) ?? current : list[0] ?? null);
      if (restoreRequest) {
        const latest = list[0];
        setQuery(latest?.query ?? "");
        setLastRequest(latest ? { query: latest.query, idempotencyKey: latest.idempotencyKey } : null);
      }
    } catch (value: unknown) {
      if (!mounted.current || generation !== authGeneration.current) return;
      handleAuthError(value);
      setHistoryError(readableError(value));
    } finally { if (mounted.current) setRefreshing(false); }
  }, [handleAuthError]);

  const connect = useCallback(async (): Promise<void> => {
    const generation = authGeneration.current;
    setInitializing(true);
    setError(null);
    try {
      const identity = await getMerchantSession();
      if (!mounted.current || generation !== authGeneration.current) return;
      setSession(identity);
      setAuthRequired(!identity.authenticated);
      if (identity.authenticated) await refreshHistory(true);
      else {
        authGeneration.current += 1;
        setOperations([]);
        setSelected(null);
        setQuery("");
        setLastRequest(null);
        setNotice(null);
      }
    } catch (value: unknown) {
      if (!mounted.current || generation !== authGeneration.current) return;
      handleAuthError(value);
      setError(readableError(value));
    } finally { if (mounted.current) setInitializing(false); }
  }, [handleAuthError, refreshHistory]);

  useEffect(() => { void connect(); }, [connect]);

  const upsertOperation = useCallback((operation: MerchantOperation): void => {
    setSelected(operation);
    setOperations((current) => [operation, ...current.filter((item) => item.id !== operation.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50));
  }, []);

  useEffect(() => {
    setPollLimitReached(false);
    if (!selected || selected.status !== "pending" || !session?.authenticated) return;
    const id = selected.id;
    const controller = new AbortController();
    let checks = 0;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const check = async (): Promise<void> => {
      try {
        const operation = await getMerchantOperation(id, controller.signal);
        if (disposed) return;
        setSelected((current) => current?.id === id ? operation : current);
        setOperations((current) => current.map((item) => item.id === id ? operation : item));
        checks += 1;
        if (operation.status !== "pending") return;
        if (checks < MAX_STATUS_CHECKS) timer = setTimeout(() => { void check(); }, STATUS_INTERVAL_MS);
        else setPollLimitReached(true);
      } catch (value: unknown) {
        if (disposed) return;
        handleAuthError(value);
        setDetailError(readableError(value));
      }
    };
    timer = setTimeout(() => { void check(); }, STATUS_INTERVAL_MS);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [selected?.id, selected?.status, session?.authenticated, handleAuthError]);

  async function runRequest(request: SearchRequest, retry: boolean): Promise<void> {
    if (busyRef.current || !session?.authenticated) return;
    const generation = authGeneration.current;
    busyRef.current = true;
    detailSequence.current += 1;
    setLoadingDetail(false);
    setBusy(true);
    setError(null);
    setDetailError(null);
    setNotice(null);
    setLastRequest(request);
    try {
      const response = await searchMerchant(request.query, request.idempotencyKey);
      if (!mounted.current || generation !== authGeneration.current) return;
      upsertOperation(response.operation);
      setNotice(response.replayed ? "Saved operation recovered. The same request key was reused." : retry ? "Request recovered with its original key." : "Search saved to your operation history.");
    } catch (value: unknown) {
      if (!mounted.current || generation !== authGeneration.current) return;
      handleAuthError(value);
      setError(readableError(value));
      if (!(value instanceof MerchantApiError && value.status === 401)) await refreshHistory();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized || normalized.length > MAX_QUERY_LENGTH || busyRef.current) return;
    const request = { query: normalized, idempotencyKey: crypto.randomUUID() };
    void runRequest(request, false);
  }

  async function selectOperation(operation: MerchantOperation): Promise<void> {
    const sequence = ++detailSequence.current;
    setSelected(operation);
    setQuery(operation.query);
    const request = { query: operation.query, idempotencyKey: operation.idempotencyKey };
    setLastRequest(request);
    setLoadingDetail(true);
    setDetailError(null);
    setNotice(null);
    try {
      const detail = await getMerchantOperation(operation.id);
      if (!mounted.current || sequence !== detailSequence.current) return;
      upsertOperation(detail);
    } catch (value: unknown) {
      if (!mounted.current || sequence !== detailSequence.current) return;
      handleAuthError(value);
      setDetailError(readableError(value));
    } finally { if (mounted.current && sequence === detailSequence.current) setLoadingDetail(false); }
  }

  const changedQuery = lastRequest && query.trim() !== lastRequest.query;
  const canSearch = Boolean(session?.authenticated && !initializing && !busy && query.trim());
  const results = selected?.result?.results ?? [];

  return (
    <div className="merchant-workspace" id="workspace">
      <section className="merchant-hero" aria-labelledby="merchant-title">
        <div className="merchant-hero-copy">
          <div className="merchant-eyebrow"><span />THE PROVIDER-FIRST WORKSPACE</div>
          <h1 id="merchant-title">Search requests.<br /><span>Every operation accounted for.</span></h1>
          <p>Build a clearer payment flow for your API. Try a search, replay the same request, and inspect the saved receipt.</p>
          <div className="merchant-hero-notes"><span><ShieldCheck size={14} />No wallet required</span><span><Database size={14} />Saved operation history</span></div>
        </div>
        <div className="merchant-flow" aria-label="Sandbox flow: one search request is saved with a request key, then its result and receipt can be retrieved again.">
          <div className="merchant-flow-title"><span className="merchant-flow-indicator" /> ONE REQUEST. ONE RECORD.<span className="merchant-flow-tag">SANDBOX</span></div>
          <div className="merchant-flow-row"><span className="merchant-flow-icon"><Search size={18} /></span><span>Search request<small>A query + a unique request key</small></span><span className="merchant-flow-number">01</span></div>
          <div className="merchant-flow-line"><ArrowDown size={14} /><span>Persist the operation</span></div>
          <div className="merchant-flow-row is-highlighted"><span className="merchant-flow-icon"><Fingerprint size={19} /></span><span>Result & operation receipt<small>Retrieve again with the same key</small></span><Check className="merchant-flow-check" size={16} /></div>
          <p>Sandbox requests do not move funds.</p>
        </div>
      </section>

      <div className="merchant-workspace-intro"><div><p className="section-kicker">MAKE YOUR FIRST REQUEST</p><h2>Your API workspace</h2></div><span className="merchant-environment"><span />Sandbox — no real payments</span></div>

      {initializing && <div className="merchant-message" role="status"><Loader2 className="merchant-spin" size={17} /><span>Connecting to your sandbox workspace…</span></div>}
      {!initializing && (authRequired || (session && !session.authenticated)) && <div className="merchant-auth-panel"><span className="merchant-auth-icon"><ShieldCheck size={21} /></span><div><strong>Your requests, saved to your workspace.</strong><p>Sign in with ChatGPT to run a search and return to your private operation history.</p></div><a className="merchant-primary-button" href={SIGN_IN_URL} target="_top">Sign in with ChatGPT<ArrowUpRight size={15} /></a></div>}
      {error && <div className="merchant-message is-error" role="alert"><CircleAlert size={18} /><div><strong>{!session ? "Workspace unavailable" : "Request could not be completed"}</strong><p>{error}</p>{!session && <button type="button" className="merchant-text-button" onClick={() => { void connect(); }} disabled={initializing}>Reconnect workspace<RefreshCw size={13} /></button>}{session && !session.authenticated && <a href={SIGN_IN_URL} target="_top">Sign in with ChatGPT<ArrowUpRight size={13} /></a>}</div></div>}
      {notice && <div className="merchant-message is-success" role="status"><Check size={17} /><span>{notice}</span></div>}

      <div className="merchant-main-grid">
        <div className="merchant-search-column">
          <section className="merchant-card merchant-search-card" aria-labelledby="search-card-title">
            <div className="merchant-card-heading"><span className="merchant-card-icon"><Search size={18} /></span><div><h3 id="search-card-title">Try a search</h3><p>{session?.corpusLabel || "Spondion documentation search"}</p></div><span className="merchant-method">POST</span></div>
            <form onSubmit={submit}>
              <label className="merchant-field-label" htmlFor="merchant-query">Search query<span>REQUIRED</span></label>
              <textarea id="merchant-query" value={query} onChange={(event) => { setQuery(event.target.value); setNotice(null); }} placeholder="How do request keys prevent duplicate operations?" maxLength={MAX_QUERY_LENGTH} rows={3} disabled={busy} aria-describedby="merchant-query-help" required />
              <div className="merchant-field-help" id="merchant-query-help"><span>Search the project documentation corpus.</span><span>{query.length}/{MAX_QUERY_LENGTH}</span></div>
              <div className="merchant-request-note"><Fingerprint size={15} /><p>{lastRequest ? changedQuery ? "You changed the query. Run search creates a new request key." : "Retry keeps this query and request key. Run as new request creates a separate operation." : "A unique request key is created when you run a search."}</p></div>
              <div className="merchant-search-actions"><button type="submit" className="merchant-primary-button" disabled={!canSearch}>{busy ? <><Loader2 className="merchant-spin" size={16} />Running search…</> : <>{lastRequest && !changedQuery ? "Run as new request" : "Run search"}<ArrowRight size={16} /></>}</button><button type="button" className="merchant-secondary-button" disabled={!lastRequest || busy || !session?.authenticated} onClick={() => { if (lastRequest) { setQuery(lastRequest.query); void runRequest(lastRequest, true); } }}><RotateCcw size={14} />Retry same request</button></div>
            </form>
            {lastRequest && <div className="merchant-request-key"><span>REQUEST KEY</span><code>{lastRequest.idempotencyKey}</code></div>}
          </section>

          <section className="merchant-card merchant-results-card" aria-labelledby="merchant-results-title" aria-busy={busy || loadingDetail}>
            <div className="merchant-card-heading"><span className="merchant-card-icon"><FileSearch size={18} /></span><div><h3 id="merchant-results-title">Search results</h3><p>{selected ? selected.query : "The response to your selected operation"}</p></div>{selected && <Status status={selected.status} />}</div>
            {busy ? <div className="merchant-empty-state"><Loader2 className="merchant-spin" size={26} /><h4>Running your request</h4><p>The operation is saved server-side. If the connection is interrupted, reuse the same request key.</p></div>
              : !selected ? <div className="merchant-empty-state"><span className="merchant-empty-icon"><FileSearch size={25} /></span><h4>A little clarity, one request away.</h4><p>Run a documentation search to see real results and a saved operation receipt here.</p></div>
                : selected.status === "succeeded" ? results.length ? <div className="merchant-results">{results.map((result, index) => { const url = safeResultUrl(result.url); return <article className="merchant-result" key={`${result.url}-${index}`}><span className="merchant-result-number">{String(index + 1).padStart(2, "0")}</span><div><h4>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{result.title}<ArrowUpRight size={14} /></a> : result.title}</h4>{url && <span className="merchant-result-url">{new URL(url).hostname}{new URL(url).pathname}</span>}<p>{result.snippet}</p></div></article>; })}<div className="merchant-result-footer"><span>{results.length} {results.length === 1 ? "result" : "results"}</span><span>Documentation corpus · sandbox</span></div></div> : <div className="merchant-empty-state"><Search size={25} /><h4>No matching documents</h4><p>Try terms such as escrow, request keys, payment, or refunds.</p></div>
                  : <div className="merchant-empty-state"><Clock3 size={26} /><h4>{selected.status === "pending" ? "Your operation is still in progress" : selected.status === "unknown" ? "This operation needs review" : "This search did not complete"}</h4><p>{selected.error || (selected.status === "pending" ? "The saved status will refresh briefly. You can also check this operation again from history." : "Inspect the receipt and retry the same request to retrieve the original operation.")}</p>{pollLimitReached && <p>Automatic checks have paused. Refresh history to check the saved status.</p>}</div>}
            {detailError && <div className="merchant-inline-error" role="alert">{detailError}</div>}
          </section>
        </div>

        <aside className="merchant-support-column" aria-label="Integration and operation details">
          <section className="merchant-integration-card"><div className="merchant-integration-title"><Terminal size={18} /><span>Built for your next API</span></div><h3>One key.<br />A request you can trace.</h3><p>Keep the same key when retrying the same query.</p><pre aria-label="Sandbox request example"><code><span>POST</span> /api/merchant/search{"\n\n"}{"{"}{"\n"}  "query": "escrow",{"\n"}  "idempotencyKey": "<span>…</span>"{"\n"}{"}"}</code></pre><a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Read the integration guide<ArrowUpRight size={14} /></a></section>
          <section className="merchant-card merchant-live-card"><div className="merchant-live-icon"><Code2 size={17} /></div><div><h3>Live integration</h3><span className="merchant-setup-status">{session?.liveConfigured ? "Configuration available" : session ? "Setup required" : "Status unavailable"}</span></div><p>{session?.liveConfigured ? "Provider configuration is available. This workspace continues to use sandbox searches with no real payments." : "A provider endpoint and payment configuration are needed before a live integration can be enabled."}</p><span className="merchant-scope-note">Current service: documentation search</span></section>
        </aside>
      </div>

      <section className="merchant-history-section" aria-labelledby="merchant-history-title">
        <div className="merchant-history-heading"><div><p className="section-kicker">A CLEAR RECORD</p><h2 id="merchant-history-title">Operation history</h2><p>Saved requests and receipts for your signed-in workspace.</p></div><button type="button" className="merchant-secondary-button" onClick={() => { void refreshHistory(); }} disabled={refreshing || initializing || !session?.authenticated}><RefreshCw size={14} className={refreshing ? "merchant-spin" : ""} />{refreshing ? "Refreshing…" : "Refresh history"}</button></div>
        {historyError && <div className="merchant-message is-error" role="alert"><CircleAlert size={16} /><span>{historyError}</span></div>}
        <div className="merchant-history-grid">
          <div className="merchant-card merchant-history-list" aria-busy={refreshing}>
            <div className="merchant-history-list-head"><span><History size={15} />Recent operations</span><span>Latest {operations.length || "—"}</span></div>
            {!operations.length ? <div className="merchant-history-empty"><History size={23} /><h4>{refreshing ? "Loading your history…" : "Your next search starts the record."}</h4><p>{session?.authenticated ? "Completed requests will stay here when you return." : "Sign in to view your saved requests."}</p></div> : <div>{operations.map((operation) => <button type="button" className={`merchant-history-row ${selected?.id === operation.id ? "is-selected" : ""}`} key={operation.id} disabled={busy} onClick={() => { void selectOperation(operation); }} aria-pressed={selected?.id === operation.id}><span className="merchant-history-row-icon"><Search size={15} /></span><span className="merchant-history-query"><strong>{operation.query}</strong><small>{dateLabel(operation.createdAt)} · {operation.mode}</small></span><Status status={operation.status} /><ChevronRight size={15} /></button>)}</div>}
          </div>
          <section className="merchant-card merchant-receipt" aria-labelledby="merchant-receipt-title"><div className="merchant-receipt-heading"><span className="merchant-card-icon"><Fingerprint size={18} /></span><h3 id="merchant-receipt-title">Operation receipt</h3>{loadingDetail && <Loader2 size={15} className="merchant-spin" />}</div>{selected ? <><div className="merchant-receipt-summary"><span>{selected.mode === "sandbox" ? "No real payment" : "Recorded amount"}</span><strong>{displayMerchantAmount(selected.amountAtomic)}</strong><Status status={selected.status} /></div><dl><div><dt>Operation ID</dt><dd><code>{selected.id}</code></dd></div><div><dt>Request key</dt><dd><code>{selected.idempotencyKey}</code></dd></div><div><dt>Mode</dt><dd>{selected.mode === "sandbox" ? "Sandbox" : "Live"}</dd></div><div><dt>Units · price per unit</dt><dd>{selected.units} · {displayMerchantAmount(selected.unitPriceAtomic)}</dd></div><div><dt>Created</dt><dd>{dateLabel(selected.createdAt)}</dd></div><div><dt>Last updated</dt><dd>{dateLabel(selected.updatedAt)}</dd></div><div><dt>Transaction</dt><dd>{selected.transaction ? <code>{selected.transaction}</code> : selected.mode === "sandbox" ? "None — sandbox operation" : "No transaction recorded"}</dd></div></dl>{selected.error && <p className="merchant-receipt-error">{selected.error}</p>}</> : <div className="merchant-receipt-empty"><Fingerprint size={27} /><p>Select an operation to inspect its request key, result, status, and recorded amount.</p></div>}</section>
        </div>
      </section>
    </div>
  );
}
