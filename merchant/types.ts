/** The only operation shape that may cross the merchant HTTP boundary. */
export interface Operation {
  id: string;
  idempotencyKey: string;
  query: string;
  mode: 'sandbox' | 'live';
  status: 'succeeded' | 'pending' | 'unknown' | 'failed';
  /** Confirmed charge only; unknown outcomes retain zero until reconciled. */
  amountAtomic: string;
  unitPriceAtomic: string;
  units: 1;
  transaction: string | null;
  result: { results: SearchResult[] } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult { title: string; url: string; snippet: string }

export interface PaymentContext {
  operationId: string;
  ownerId: string;
  query: string;
  amountAtomic: string;
  unitPriceAtomic: string;
  units: 1;
}

export interface VerifiedPayment {
  /** Stable network+payer+nonce identity of the proof, independent of the operation. */
  authorizationId: string;
  /** Adapter-owned data, persisted server-side and never exposed in Operation. */
  payload: unknown;
}

export interface PaymentAdapter {
  /** Verification MUST NOT transfer funds or submit a settlement. */
  verify(input: unknown, context: PaymentContext): Promise<VerifiedPayment>;
  /** Called at most once. A rejection is an ambiguous outcome requiring reconciliation. */
  settle(authorization: VerifiedPayment, context: PaymentContext): Promise<{ transaction: string }>;
}
