# Provider setup and settlement recovery

## Save an integration draft

Open **Provider setup** in the Merchant Workspace and sign in with ChatGPT. Save a provider name, public HTTPS search endpoint, Base payout address and a USDC price. Optional fields may remain blank while preparing an integration. Prices use six decimal places, from 0.000001 through 100 USDC per search.

Drafts belong to the signed-in account and survive reloads. The workspace never fetches a draft endpoint, requests wallet signatures or activates payments when a draft is saved. Endpoint checks validate URL syntax; they do not verify ownership or service quality. Do not enter API keys, passwords, signed URLs or other secrets in any draft field. The setup template references secret environment variables to be configured separately by the deployment operator.

This release still has one operator-managed paid integration. Each signed-in visitor's draft is independent of the operator's deployed `/v1` settings. Saving a complete draft is preparation for review, not a hosted payment account or a public provider listing. The public workspace continues to use the free documentation search sandbox.

## Inspect an uncertain settlement

The operator can reconcile an original paid operation after a facilitator timeout. Keep its original operation ID and transaction hash. Do not create a new key, sign another authorization or resubmit payment because a response was lost.

`POST /v1/operations/<operationId>/reconcile`

Use the existing merchant Bearer credential and JSON containing only:

```json
{"transaction":"0x<original-64-hex-character-transaction-hash>"}
```

This endpoint reads the fixed public Base RPC. It never calls a facilitator's settle endpoint and has no signer. It validates a successful canonical receipt at finalized chain state, the official Base USDC address, the original payer, recipient, amount and EIP-3009 nonce. The token's matching `AuthorizationUsed` must immediately precede the corresponding `Transfer`. A generic transfer or a different authorization cannot recover the operation.

Only a live operation with `PAYMENT_OUTCOME_UNKNOWN`, its saved result and original verified authorization is eligible. A successful check atomically records the receipt evidence and releases the saved result, once. Repeating the same reconciliation returns the same confirmed record; a different hash conflicts. A mismatch, unavailable RPC, missing receipt or insufficient finality leaves the unresolved operation unchanged. No new payment is attempted. Saved reads and this recovery endpoint remain available with the operator credential when live charging is disabled.

The public operation includes safe reconciliation evidence: chain/token, transaction and block hashes, block number, payer, recipient, amount, nonce, finality and check time. It does not return payment signatures or the stored verification token. This verifies a transfer, not the quality of delivered search results. It cannot prove a refund is owed or automatically reverse a payment.

## Operational limits

Base recovery and the Arc prepaid escrow are separate flows. Neither onboarding nor reconciliation completes the Arc Mainnet grant requirements. Live credentials, a reviewed recipient, upstream provider agreement, deployment-specific recovery checks and explicit approval for a concrete money action remain necessary before a paid pilot. This release performs no real paid requests or Mainnet deployment.

Rollback: redeploy the prior Worker version. Keep the new provider table and nullable reconciliation column; the previous Worker ignores them. Do not roll back or delete D1 migration history.
