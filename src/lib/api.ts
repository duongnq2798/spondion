/**
 * Typed API client for the Spondion demo backend.
 * All calls go to /api (Vite proxy → localhost:3001).
 *
 * Amounts (units, pricePerUnit, balance, etc.) are always decimal integer strings
 * to preserve full uint256 precision without relying on Number.
 */

import { type Channel, type Settlement } from "../types";

const BASE = "/api";

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data;
}

// ── Response shapes ───────────────────────────────────────────────────────────

export interface StatusResponse {
  ready: boolean;
  chainId?: number;
  escrow?: string;
  usdc?: string;
  rpcUrl?: string;
  fixture?: { owner: string; provider: string; payout: string };
}

export interface ListResponse {
  channels: Channel[];
  providerCredit: Record<string, string>; // decimal string per payout address
  settlements: Settlement[];
}

export interface ChannelResponse { channel: Channel; txHash?: string }

export interface VoucherResponse {
  voucher: {
    channelId: string;
    requestId: string;
    units: string;       // decimal string
    deadline: string;    // decimal seconds string
    deadlineMs: number;
    signature: string;
  };
  signedBy: string;
  signingMethod: "EIP-712";
}

export interface SettleResponse {
  settlement: Settlement;
  channelBalance: string;
  providerCredit: string;
  txHash: string;
  blockNumber: string;
}

export interface CloseResponse { channel: Channel; txHash: string; refundAvailableAt: string }
export interface SkipTimeResponse { skippedSeconds: number; message: string }
export interface RefundResponse { refunded: string; channel: Channel; txHash: string }
export interface WithdrawResponse { withdrawn: string; payout: string; txHash: string }
export interface DemoCompleteResponse {
  prompt: string;
  units: string;
  amount: string;
  requestId: string;
  txHash: string;
  channelBalance: string;
  message: string;
}

// ── API ───────────────────────────────────────────────────────────────────────

export const api = {
  status:     ()                                                    => apiCall<StatusResponse>("GET", "/status"),
  list:       ()                                                    => apiCall<ListResponse>("GET", "/channels"),
  getChannel: (id: string)                                          => apiCall<ChannelResponse>("GET", `/channels/${id}`),

  openChannel: (p: {
    pricePerUnit: string; perCallCap: string; lifetimeCap: string; initialDeposit: string;
  })                                                                => apiCall<ChannelResponse>("POST", "/channels", p),

  requestVoucher: (channelId: string, units: string)               => apiCall<VoucherResponse>("POST", `/channels/${channelId}/voucher`, { units }),

  settle: (channelId: string, v: {
    requestId: string; units: string; deadline: string; signature: string;
  })                                                                => apiCall<SettleResponse>("POST", `/channels/${channelId}/settle`, v),

  requestClose:   (channelId: string)                              => apiCall<CloseResponse>("POST", `/channels/${channelId}/close`),
  skipTime:       (channelId: string)                              => apiCall<SkipTimeResponse>("POST", `/channels/${channelId}/skip-time`),
  finalizeRefund: (channelId: string)                              => apiCall<RefundResponse>("POST", `/channels/${channelId}/refund`),
  withdraw:       (payout?: string)                                => apiCall<WithdrawResponse>("POST", "/withdraw", payout ? { payout } : {}),

  demoComplete: (channelId: string, prompt: string)                => apiCall<DemoCompleteResponse>("POST", "/demo/complete", { channelId, prompt }),
};
