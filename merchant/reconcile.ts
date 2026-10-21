import { createPublicClient, decodeEventLog, http, parseAbi, type Hex } from 'viem';
import { base } from 'viem/chains';
import { OperationError, publicOperation } from './core.ts';
import { createOperationStore, type OperationRow, type SqlDatabase } from './store.ts';
import type { Operation, ReconciliationEvidence } from './types.ts';
import { X402_NETWORK, X402_USDC } from './x402.ts';

const EVENTS = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
const hash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= (1n << 256n) - 1n;
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface ReceiptLog {
  address: string;
  data: Hex;
  topics: Hex[];
  logIndex: number | null;
  transactionHash?: string | null;
  blockHash?: string | null;
  removed?: boolean;
}
export interface SettlementSnapshot {
  chainId: number;
  finalizedBlockNumber: bigint;
  canonicalBlockHash: string;
  receipt: { status: string; transactionHash: string; blockHash: string; blockNumber: bigint; logs: ReceiptLog[] };
}
export type SettlementVerifier = (transaction: Hex) => Promise<SettlementSnapshot>;

/** Only reads a pinned public Base endpoint; callers cannot supply a signer, transport or RPC URL. */
export const readBaseSettlement: SettlementVerifier = async transaction => {
  const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org', { timeout: 10_000, retryCount: 0 }) });
  const [chainId, receipt, finalized] = await Promise.all([
    client.getChainId(), client.getTransactionReceipt({ hash: transaction }), client.getBlock({ blockTag: 'finalized' }),
  ]);
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  return { chainId, receipt, finalizedBlockNumber: finalized.number, canonicalBlockHash: canonical.hash };
};

interface OriginalAuthorization { payer: string; recipient: string; amount: string; nonce: Hex }
function originalAuthorization(row: OperationRow): OriginalAuthorization {
  const invalid = () => new OperationError('RECONCILIATION_NOT_ELIGIBLE', 409, 'Only an unresolved submitted payment with its original saved result and authorization can be reconciled.');
  if (row.mode !== 'live' || row.phase !== 'unknown' || row.error_code !== 'PAYMENT_OUTCOME_UNKNOWN' || !row.result_json || !row.authorization_json || row.authorization_json.length > 32768 || row.transaction_id || row.reconciliation_json) throw invalid();
  try {
    const result: unknown = JSON.parse(row.result_json);
    if (!record(result) || !Array.isArray(result.results)) throw invalid();
    const stored: unknown = JSON.parse(row.authorization_json);
    if (!record(stored) || !record(stored.payload) || typeof stored.payload.verificationToken !== 'string' || !record(stored.payload.payment)) throw invalid();
    const payment = stored.payload.payment;
    if (payment.x402Version !== 2 || !record(payment.accepted) || !record(payment.payload)) throw invalid();
    const accepted = payment.accepted, authorization = payment.payload.authorization;
    if (accepted.scheme !== 'exact' || accepted.network !== X402_NETWORK || typeof accepted.asset !== 'string' || !equal(accepted.asset, X402_USDC) || accepted.amount !== row.unit_price_atomic || !record(accepted.extra) || accepted.extra.assetTransferMethod !== 'eip3009') throw invalid();
    if (!record(authorization) || !address(authorization.from) || !address(authorization.to) || !address(accepted.payTo) || !equal(authorization.to, accepted.payTo) || !integer(authorization.value) || authorization.value === '0' || authorization.value !== row.unit_price_atomic || !hash(authorization.nonce) || !integer(authorization.validAfter) || !integer(authorization.validBefore) || BigInt(authorization.validBefore) <= BigInt(authorization.validAfter)) throw invalid();
    const identity = `${X402_NETWORK}:${authorization.from.toLowerCase()}:${authorization.nonce.toLowerCase()}`;
    if (stored.authorizationId !== identity || row.authorization_id !== identity) throw invalid();
    return { payer: authorization.from.toLowerCase(), recipient: authorization.to.toLowerCase(), amount: authorization.value, nonce: authorization.nonce.toLowerCase() as Hex };
  } catch { throw invalid(); }
}

function verifySnapshot(snapshot: SettlementSnapshot, transaction: Hex, original: OriginalAuthorization, checkedAt: string): ReconciliationEvidence {
  const mismatch = () => new OperationError('RECONCILIATION_MISMATCH', 422, 'The finalized receipt does not prove this original USDC authorization and transfer.');
  const { receipt } = snapshot;
  if (snapshot.chainId !== 8453 || receipt.status !== 'success' || !hash(receipt.transactionHash) || !equal(receipt.transactionHash, transaction) || !hash(receipt.blockHash) || !hash(snapshot.canonicalBlockHash) || !equal(receipt.blockHash, snapshot.canonicalBlockHash) || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n || typeof snapshot.finalizedBlockNumber !== 'bigint') throw mismatch();
  if (snapshot.finalizedBlockNumber < receipt.blockNumber) throw new OperationError('RECONCILIATION_PENDING', 409, 'The receipt has not reached finalized chain state. Keep the original operation and check again later.');
  if (!Array.isArray(receipt.logs) || receipt.logs.length > 2000) throw mismatch();
  const logs = [...receipt.logs].sort((a, b) => (a.logIndex ?? -1) - (b.logIndex ?? -1));
  const seen = new Set<number>();
  for (const log of logs) {
    if (!Number.isSafeInteger(log.logIndex) || log.logIndex === null || log.logIndex < 0 || seen.has(log.logIndex) || log.removed || (log.transactionHash && !equal(log.transactionHash, transaction)) || (log.blockHash && !equal(log.blockHash, receipt.blockHash))) throw mismatch();
    seen.add(log.logIndex);
  }
  let matchingAuthorization = 0, provenTransfer = 0;
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (!equal(log.address, X402_USDC)) continue;
    let decoded;
    try { decoded = decodeEventLog({ abi: EVENTS, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true }); }
    catch { continue; }
    if (decoded.eventName !== 'AuthorizationUsed' || !equal(decoded.args.authorizer, original.payer) || !equal(decoded.args.nonce, original.nonce)) continue;
    matchingAuthorization++;
    // Circle's EIP3009 emits AuthorizationUsed immediately before its Transfer. Adjacency
    // prevents a separate transfer elsewhere in a batched transaction proving this nonce.
    // Source: https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol
    const transfer = logs[i + 1];
    if (!transfer || transfer.logIndex !== log.logIndex! + 1 || !equal(transfer.address, X402_USDC)) continue;
    try {
      const event = decodeEventLog({ abi: EVENTS, eventName: 'Transfer', topics: transfer.topics as [Hex, ...Hex[]], data: transfer.data, strict: true });
      if (equal(event.args.from, original.payer) && equal(event.args.to, original.recipient) && event.args.value === BigInt(original.amount)) provenTransfer++;
    } catch { /* An unparseable event is not payment proof. */ }
  }
  if (matchingAuthorization !== 1 || provenTransfer !== 1) throw mismatch();
  return { network: X402_NETWORK, asset: X402_USDC, transaction, blockHash: receipt.blockHash.toLowerCase(), blockNumber: receipt.blockNumber.toString(), payer: original.payer, recipient: original.recipient, amountAtomic: original.amount, nonce: original.nonce, checkedAt, finality: 'finalized' };
}

export function createReconciliationService(options: { db: SqlDatabase; verifier?: SettlementVerifier; now?: () => Date }) {
  const store = createOperationStore(options.db);
  const verifier = options.verifier ?? readBaseSettlement;
  const now = options.now ?? (() => new Date());
  return {
    async reconcile(ownerId: string, id: string, transaction: string): Promise<Operation> {
      if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200) throw new OperationError('AUTHENTICATION_REQUIRED', 401, 'A merchant identity is required.');
      if (!hash(transaction)) throw new OperationError('INVALID_TRANSACTION_HASH', 400, 'Provide the original 32-byte transaction hash.');
      const normalized = transaction.toLowerCase() as Hex;
      const row = typeof id === 'string' && id.length <= 128 ? await store.get(ownerId, id) : null;
      if (!row) throw new OperationError('NOT_FOUND', 404, 'Operation not found.');
      if (row.phase === 'succeeded') {
        if (row.reconciliation_json && row.transaction_id && equal(row.transaction_id, normalized)) return publicOperation(row);
        throw new OperationError('RECONCILIATION_CONFLICT', 409, 'This operation already has a confirmed transaction.');
      }
      const original = originalAuthorization(row);
      let snapshot: SettlementSnapshot;
      try { snapshot = await verifier(normalized); }
      catch { throw new OperationError('RECONCILIATION_UNAVAILABLE', 503, 'The original receipt could not be verified. Keep the same operation; no payment was submitted.'); }
      const evidence = verifySnapshot(snapshot, normalized, original, now().toISOString());
      const updated = await store.reconcile(row, normalized, JSON.stringify(evidence), evidence.checkedAt);
      if (updated) return publicOperation(updated);
      const current = await store.get(ownerId, id);
      if (current?.phase === 'succeeded' && current.reconciliation_json && current.transaction_id && equal(current.transaction_id, normalized)) return publicOperation(current);
      throw new OperationError('RECONCILIATION_CONFLICT', 409, 'The operation changed while its receipt was being checked. Read its original record.');
    },
  };
}
