export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface MerchantOperation {
  id: string;
  idempotencyKey: string;
  query: string;
  mode: "sandbox" | "live";
  status: "succeeded" | "pending" | "unknown" | "failed";
  amountAtomic: string;
  unitPriceAtomic: string;
  units: 1;
  transaction: string | null;
  result: { results: SearchResult[] } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantSession {
  authenticated: boolean;
  user: { name: string } | null;
  mode: "sandbox";
  liveConfigured: boolean;
  signInUrl: string;
  corpusLabel: string;
}

export class MerchantApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = "MerchantApiError";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const ATOMIC_AMOUNT = /^(0|[1-9]\d*)$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const invalidResponse = () => new MerchantApiError("The workspace returned an unexpected response. Refresh to check the saved operation before retrying.", 502, "INVALID_RESPONSE");

function isOperation(value: unknown): value is MerchantOperation {
  if (!record(value)) return false;
  const result = value.result;
  return typeof value.id === "string" && typeof value.idempotencyKey === "string" && typeof value.query === "string"
    && (value.mode === "sandbox" || value.mode === "live")
    && ["succeeded", "pending", "unknown", "failed"].includes(String(value.status))
    && typeof value.amountAtomic === "string" && ATOMIC_AMOUNT.test(value.amountAtomic)
    && typeof value.unitPriceAtomic === "string" && ATOMIC_AMOUNT.test(value.unitPriceAtomic)
    && value.units === 1 && nullableString(value.transaction) && nullableString(value.error)
    && typeof value.createdAt === "string" && typeof value.updatedAt === "string"
    && (result === null || (record(result) && Array.isArray(result.results) && result.results.every((item: unknown) =>
      record(item) && typeof item.title === "string" && typeof item.url === "string" && typeof item.snippet === "string")));
}

async function request(path: string, body?: { query: string; idempotencyKey: string }, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/merchant${path}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!response.ok) {
      const error = record(data) && record(data.error) ? data.error : null;
      const fallback = response.status === 401 ? "Sign in with ChatGPT to use your sandbox workspace."
        : response.status === 503 ? "The sandbox is temporarily unavailable. Your existing request key is preserved."
          : `The request could not be completed (HTTP ${response.status}).`;
      throw new MerchantApiError(typeof error?.message === "string" ? error.message : fallback, response.status, typeof error?.code === "string" ? error.code : "HTTP_ERROR");
    }
    if (!record(data)) throw invalidResponse();
    return data;
  } catch (error: unknown) {
    if (error instanceof MerchantApiError) throw error;
    if (controller.signal.aborted) throw new MerchantApiError("The request timed out. Check history or retry the same request to recover its saved status.", 0, "TIMEOUT");
    throw new MerchantApiError("Could not reach the workspace. Check your connection, then retry the same request.", 0, "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function getMerchantSession(signal?: AbortSignal): Promise<MerchantSession> {
  const data = await request("/me", undefined, signal);
  if (!record(data) || typeof data.authenticated !== "boolean" || data.mode !== "sandbox" || typeof data.liveConfigured !== "boolean"
    || typeof data.signInUrl !== "string" || typeof data.corpusLabel !== "string"
    || !(data.user === null || (record(data.user) && typeof data.user.name === "string"))) throw invalidResponse();
  return data as unknown as MerchantSession;
}

export async function getMerchantOperations(signal?: AbortSignal): Promise<MerchantOperation[]> {
  const data = await request("/operations", undefined, signal);
  if (!record(data) || !Array.isArray(data.operations) || !data.operations.every(isOperation)) throw invalidResponse();
  return data.operations;
}

export async function getMerchantOperation(id: string, signal?: AbortSignal): Promise<MerchantOperation> {
  const data = await request(`/operations/${encodeURIComponent(id)}`, undefined, signal);
  if (!record(data) || !isOperation(data.operation)) throw invalidResponse();
  return data.operation;
}

export async function searchMerchant(query: string, idempotencyKey: string): Promise<{ operation: MerchantOperation; replayed: boolean }> {
  const data = await request("/search", { query, idempotencyKey });
  if (!record(data) || !isOperation(data.operation) || typeof data.replayed !== "boolean") throw invalidResponse();
  return { operation: data.operation, replayed: data.replayed };
}

/** Only HTTPS result URLs without embedded credentials become clickable. */
export function safeResultUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** USDC has six decimal places. Keep all monetary arithmetic exact. */
export function displayMerchantAmount(value: string): string {
  if (!ATOMIC_AMOUNT.test(value)) return "Unavailable";
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} USDC`;
}
