export const MAX_UINT256 = (1n << 256n) - 1n;
export const VOUCHER_NAME = "SpondionPrepaidEscrow";
export const VOUCHER_VERSION = "1";

export function parseUint256Strict(raw: unknown, field = "Value", min = 0n): bigint {
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw) || raw.length > 78) {
    throw new Error(`${field} must be a canonical decimal integer string`);
  }
  const n = BigInt(raw);
  if (n < min || n > MAX_UINT256) throw new Error(`${field} is outside its allowed uint256 range`);
  return n;
}

export function parseUsdcStrict(raw: string, decimals: number):
  { ok: true; baseUnits: bigint; display: string } | { ok: false; error: string } {
  if (decimals !== 6) return { ok: false, error: "Spondion requires 6-decimal USDC" };
  const s = raw.trim();
  if (!/^[0-9]+(?:\.[0-9]{1,6})?$/.test(s) || s.length > 85) {
    return { ok: false, error: "Enter a plain USDC amount with at most 6 decimal places" };
  }
  const [whole = "0", fraction = ""] = s.split(".");
  const n = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (n === 0n || n > MAX_UINT256) return { ok: false, error: "Amount must be positive and fit uint256" };
  const fractional = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const decimal = (n / 1_000_000n).toString() + (fractional ? "." + fractional : "");
  return { ok: true, baseUnits: n, display: `${decimal} USDC = ${n} base units` };
}

export interface ExportedVoucher {
  name: typeof VOUCHER_NAME;
  version: typeof VOUCHER_VERSION;
  chainId: number;
  escrow: string;
  channelId: string;
  requestId: `0x${string}`;
  units: string;
  deadline: string;
  signature: `0x${string}`;
}

export function validateVoucher(raw: unknown, targetChainId: number, escrowAddress: string):
  { ok: true; voucher: ExportedVoucher } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Voucher must be a JSON object" };
  const v = raw as Record<string, unknown>;
  if (v.name !== VOUCHER_NAME || v.version !== VOUCHER_VERSION) return { ok: false, error: "Voucher protocol name or version does not match" };
  if (!Number.isSafeInteger(v.chainId) || v.chainId !== targetChainId) return { ok: false, error: "Voucher chain does not match" };
  if (typeof v.escrow !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v.escrow) || v.escrow.toLowerCase() !== escrowAddress.toLowerCase()) {
    return { ok: false, error: "Voucher escrow does not match" };
  }
  try {
    parseUint256Strict(v.channelId, "Channel ID");
    parseUint256Strict(v.units, "Units", 1n);
    parseUint256Strict(v.deadline, "Deadline");
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Invalid voucher integer" }; }
  if (typeof v.requestId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.requestId)) return { ok: false, error: "Request ID must be exactly bytes32" };
  // EIP-1271 wallets may accept empty or variable-length signatures.
  if (typeof v.signature !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(v.signature)) return { ok: false, error: "Signature must contain whole hexadecimal bytes" };
  return { ok: true, voucher: {
    name: VOUCHER_NAME, version: VOUCHER_VERSION, chainId: targetChainId,
    escrow: v.escrow, channelId: v.channelId as string, requestId: v.requestId as `0x${string}`,
    units: v.units as string, deadline: v.deadline as string, signature: v.signature as `0x${string}`,
  } };
}

