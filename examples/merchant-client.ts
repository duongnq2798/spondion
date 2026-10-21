import { privateKeyToAccount } from 'viem/accounts';
import { createX402MerchantClient } from '../sdk/client.ts';

// Intentionally not run by tests or imported by the UI. This makes a real Base payment.
if (process.env.SPONDION_ALLOW_PAID_REQUEST !== 'true') {
  throw new Error('Paid requests are disabled. Review the merchant, recipient and atomic budget, then explicitly set SPONDION_ALLOW_PAID_REQUEST=true to opt in.');
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in the caller environment`);
  return value;
}
const privateKey = required('SPONDION_CALLER_PRIVATE_KEY');
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Invalid caller private key format');
const client = createX402MerchantClient({
  baseUrl: required('SPONDION_MERCHANT_URL'),
  apiKey: required('SPONDION_MERCHANT_API_KEY'),
  signer: privateKeyToAccount(privateKey as `0x${string}`),
  recipient: required('SPONDION_PAY_TO'),
  maxAmountAtomic: required('SPONDION_MAX_AMOUNT_ATOMIC'),
});
// Persist a 16–128 character logical key before submission. After interruption, find the original operation.
const idempotencyKey = required('SPONDION_REQUEST_ID');
const response = await client.search(required('SPONDION_QUERY'), { idempotencyKey });
console.log(JSON.stringify({ requestId: idempotencyKey, httpStatus: response.status, result: await response.json() }, null, 2));
