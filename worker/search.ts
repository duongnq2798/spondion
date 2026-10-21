import type { SearchResult } from '../merchant/types.ts';
import { IndeterminateOperationError } from '../merchant/core.ts';

export const CORPUS_LABEL = 'Spondion documentation search';
const CORPUS: SearchResult[] = [
  { title: 'Prepaid USDC channels', url: 'https://github.com/duongnq2798/spondion#readme', snippet: 'Spondion channels connect an owner, provider, payout and signer. Deposit USDC, authorize usage within spending caps and refund unused channel balances. This sandbox searches Spondion documentation only.' },
  { title: 'Refunds and closing a channel', url: 'https://github.com/duongnq2798/spondion/blob/main/docs/architecture.md', snippet: 'The Arc escrow moves from Active to Closing to Closed. Providers can settle before the refund boundary. After the grace period the owner can refund the unused balance. Refunding a channel does not reverse a previously settled charge.' },
  { title: 'Retry without duplicate charges', url: 'https://github.com/duongnq2798/spondion/blob/main/docs/MERCHANT-INTEGRATION.md', snippet: 'Keep the same idempotency key for the same logical search. A repeated request returns its recorded result and payment state. Reusing that key with a different query is rejected. Pending or uncertain payments require reconciliation.' },
  { title: 'Provider search integration', url: 'https://github.com/duongnq2798/spondion/blob/main/docs/MERCHANT-INTEGRATION.md', snippet: 'The merchant integration accepts one basic search query and returns up to five ranked titles, URLs and snippets. API providers configure their own endpoint and price. Streaming, generated answers and bulk crawling are outside this pilot.' },
  { title: 'x402 exact payments on Base', url: 'https://github.com/duongnq2798/spondion/blob/main/docs/MERCHANT-INTEGRATION.md', snippet: 'The optional x402 adapter uses maintained SDKs for exact USDC payments on Base. Live mode requires recipient, facilitator, upstream and API credentials. Sandbox operations do not sign transactions, spend USDC or call paid APIs.' },
  { title: 'Recover a stored search result', url: 'https://github.com/duongnq2798/spondion/blob/main/docs/MERCHANT-INTEGRATION.md', snippet: 'Operation and result records live in a durable database. Reload the workspace or retry the original request to recover a completed result. Interrupted execution becomes unknown instead of silently running the work and charging again.' },
  { title: 'Arc escrow safety and authorization', url: 'https://github.com/duongnq2798/spondion/blob/main/docs/architecture.md', snippet: 'EIP-712 vouchers authorize a channel, request ID, units and deadline. Caps, provider roles and consumed-request tracking are enforced by the escrow. Signed vouchers do not reserve funds or prove that AI work was completed.' },
  { title: 'Receipts and reconciliation', url: 'https://github.com/duongnq2798/spondion/blob/main/docs/MERCHANT-INTEGRATION.md', snippet: 'An operation receipt links a stable request ID, one billable unit, exact atomic amount and a confirmed transaction where available. Sandbox receipts show zero charged and no transaction. Unknown settlement is never shown as confirmed revenue.' },
];

export async function searchDocumentation(query: string): Promise<SearchResult[]> {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1);
  return CORPUS.map(item => ({ item, score: terms.reduce((n, term) => n + (item.title.toLowerCase().includes(term) ? 3 : 0) + (item.snippet.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(row => row.item);
}

export function createProviderSearch(endpoint: string, apiKey: string, fetcher: typeof fetch = fetch) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.') || /(^localhost$|\.local$|\.internal$|^\d+\.\d+\.\d+\.\d+$)/i.test(url.hostname)) {
    throw new Error('Provider must be a configured public HTTPS endpoint.');
  }
  return async (query: string): Promise<SearchResult[]> => {
    let response: Response;
    try {
      response = await fetcher(url.href, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query, max_results: 5, search_depth: 'basic', include_answer: false }), signal: AbortSignal.timeout(15_000) });
    } catch { throw new IndeterminateOperationError('Provider outcome is unknown.'); }
    if (!response.ok) throw new Error('Provider search failed.');
    const text = await readBoundedBody(response, 65_536);
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || !('results' in body) || !Array.isArray(body.results)) throw new Error('Invalid provider search response.');
    return body.results.slice(0, 5).map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new Error('Invalid search result.');
      const row = item as Record<string, unknown>;
      if (typeof row.title !== 'string' || typeof row.url !== 'string' || typeof (row.snippet ?? row.content) !== 'string') throw new Error('Invalid search result.');
      const resultUrl = new URL(row.url);
      if (resultUrl.protocol !== 'https:' || resultUrl.username || resultUrl.password) throw new Error('Unsafe result URL.');
      return { title: row.title.slice(0, 200), url: row.url, snippet: String(row.snippet ?? row.content).slice(0, 1000) };
    });
  };
}

export async function readBoundedBody(message: Request | Response, limit: number): Promise<string> {
  if (Number(message.headers.get('Content-Length') ?? 0) > limit) throw new RangeError('Body exceeds limit.');
  if (!message.body) return '';
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RangeError('Body exceeds limit.'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}
