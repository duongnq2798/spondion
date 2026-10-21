/** Shared types used by both the API client and frontend components. */

export interface Channel {
  channelId: string;
  owner: string;
  provider: string;
  payout: string;
  signer: string;
  pricePerUnit: string;    // micro-USDC, bigint-safe decimal string
  perCallCap: string;
  lifetimeCap: string;
  balance: string;
  spent: string;
  refundAvailableAt: string;  // unix seconds decimal string
  state: "Active" | "Closing" | "Closed";
}

export interface Settlement {
  channelId:      string;
  requestId:      string;
  units:          string;  // [S10] decimal string — bigint-safe
  amount:         string;  // [S10] micro-USDC decimal string — from UsageSettled event
  blockTimestamp: number;  // [S6] unix seconds from the block that mined the event
  txHash:         string;
}

/** Convert a micro-USDC decimal string (or number) to a human display string.
 *  6-decimal ERC-20: 1_000_000 base-units = 1.000000 USDC */
export function microToDisplay(micro: string | number): string {
  const s = typeof micro === "number" ? String(micro) : micro;
  try {
    const n = BigInt(s);
    const whole = n / 1_000_000n;
    const frac  = n % 1_000_000n;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  } catch {
    const f = parseFloat(s);
    return isNaN(f) ? "0" : (f / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
  }
}
