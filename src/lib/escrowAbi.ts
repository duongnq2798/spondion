/**
 * Spondion Prepaid Escrow — ABI exported for frontend viem usage.
 * Generated from contracts/out/SpondionPrepaidEscrow.sol/SpondionPrepaidEscrow.json
 * DO NOT edit by hand — regenerate with: bun run contracts:build
 */

export const ESCROW_ABI = [
  {
    "type": "constructor",
    "inputs": [
      { "name": "_usdc", "type": "address" },
      { "name": "_graceDuration", "type": "uint256" }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "GRACE_DURATION",
    "inputs": [], "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "openChannel",
    "inputs": [
      { "name": "provider",     "type": "address" },
      { "name": "payout",       "type": "address" },
      { "name": "signer",       "type": "address" },
      { "name": "pricePerUnit", "type": "uint256" },
      { "name": "perCallCap",   "type": "uint256" },
      { "name": "lifetimeCap",  "type": "uint256" }
    ],
    "outputs": [{ "name": "channelId", "type": "uint256" }],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "deposit",
    "inputs": [
      { "name": "channelId", "type": "uint256" },
      { "name": "amount",    "type": "uint256" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "settleUsage",
    "inputs": [
      { "name": "channelId",  "type": "uint256" },
      { "name": "requestId",  "type": "bytes32" },
      { "name": "units",      "type": "uint256" },
      { "name": "deadline",   "type": "uint256" },
      { "name": "signature",  "type": "bytes"   }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "requestClose",
    "inputs": [{ "name": "channelId", "type": "uint256" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "finalizeRefund",
    "inputs": [{ "name": "channelId", "type": "uint256" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "withdraw",
    "inputs": [], "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "getChannel",
    "inputs": [{ "name": "channelId", "type": "uint256" }],
    "outputs": [{
      "name": "", "type": "tuple",
      "components": [
        { "name": "owner",            "type": "address" },
        { "name": "provider",         "type": "address" },
        { "name": "payout",           "type": "address" },
        { "name": "signer",           "type": "address" },
        { "name": "pricePerUnit",     "type": "uint256" },
        { "name": "perCallCap",       "type": "uint256" },
        { "name": "lifetimeCap",      "type": "uint256" },
        { "name": "balance",          "type": "uint256" },
        { "name": "spent",            "type": "uint256" },
        { "name": "refundAvailableAt","type": "uint256" },
        { "name": "state",            "type": "uint8"   }
      ]
    }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "isVoucherConsumed",
    "inputs": [
      { "name": "channelId",  "type": "uint256" },
      { "name": "requestId",  "type": "bytes32" }
    ],
    "outputs": [{ "name": "", "type": "bool" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "getDomainSeparator",
    "inputs": [], "outputs": [{ "name": "", "type": "bytes32" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "hashVoucher",
    "inputs": [
      { "name": "channelId", "type": "uint256" },
      { "name": "requestId", "type": "bytes32" },
      { "name": "units",     "type": "uint256" },
      { "name": "deadline",  "type": "uint256" }
    ],
    "outputs": [{ "name": "", "type": "bytes32" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "nextChannelId",
    "inputs": [], "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "providerCredit",
    "inputs": [{ "name": "", "type": "address" }],
    "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "totalLiabilities",
    "inputs": [], "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "usdc",
    "inputs": [], "outputs": [{ "name": "", "type": "address" }],
    "stateMutability": "view"
  },
  {
    "type": "event", "name": "ChannelOpened",
    "inputs": [
      { "name": "channelId", "type": "uint256", "indexed": true },
      { "name": "owner",     "type": "address", "indexed": true },
      { "name": "provider",  "type": "address", "indexed": true },
      { "name": "payout",    "type": "address", "indexed": false },
      { "name": "signer",    "type": "address", "indexed": false },
      { "name": "pricePerUnit", "type": "uint256", "indexed": false },
      { "name": "perCallCap",   "type": "uint256", "indexed": false },
      { "name": "lifetimeCap",  "type": "uint256", "indexed": false }
    ],
    "anonymous": false
  },
  {
    "type": "event", "name": "UsageSettled",
    "inputs": [
      { "name": "channelId", "type": "uint256", "indexed": true },
      { "name": "requestId", "type": "bytes32", "indexed": true },
      { "name": "units",     "type": "uint256", "indexed": false },
      { "name": "amount",    "type": "uint256", "indexed": false }
    ],
    "anonymous": false
  },
  {
    "type": "event", "name": "Deposited",
    "inputs": [
      { "name": "channelId",  "type": "uint256", "indexed": true },
      { "name": "amount",     "type": "uint256", "indexed": false },
      { "name": "newBalance", "type": "uint256", "indexed": false }
    ],
    "anonymous": false
  },
  {
    "type": "event", "name": "ClosingRequested",
    "inputs": [
      { "name": "channelId",        "type": "uint256", "indexed": true },
      { "name": "refundAvailableAt","type": "uint256", "indexed": false }
    ],
    "anonymous": false
  },
  {
    "type": "event", "name": "Refunded",
    "inputs": [
      { "name": "channelId", "type": "uint256", "indexed": true },
      { "name": "amount",    "type": "uint256", "indexed": false },
      { "name": "owner",     "type": "address", "indexed": false }
    ],
    "anonymous": false
  },
  {
    "type": "event", "name": "ProviderWithdrawn",
    "inputs": [
      { "name": "payout", "type": "address", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
    ],
    "anonymous": false
  }
] as const;

export const ERC20_ABI = [
  { "type": "function", "name": "approve",     "inputs": [{ "name": "spender", "type": "address" }, { "name": "amount",  "type": "uint256" }], "outputs": [{ "name": "", "type": "bool" }], "stateMutability": "nonpayable" },
  { "type": "function", "name": "transfer",    "inputs": [{ "name": "to",      "type": "address" }, { "name": "amount",  "type": "uint256" }], "outputs": [{ "name": "", "type": "bool" }], "stateMutability": "nonpayable" },
  { "type": "function", "name": "balanceOf",   "inputs": [{ "name": "account", "type": "address" }],                                           "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view" },
  { "type": "function", "name": "allowance",   "inputs": [{ "name": "owner",   "type": "address" }, { "name": "spender", "type": "address" }], "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view" },
  { "type": "function", "name": "decimals",    "inputs": [],                                                                                    "outputs": [{ "name": "", "type": "uint8"   }], "stateMutability": "view" },
] as const;

/** EIP-712 domain + types for frontend signTypedData */
export const VOUCHER_DOMAIN = {
  name: "SpondionPrepaidEscrow",
  version: "1",
} as const;

export const VOUCHER_TYPES = {
  UsageVoucher: [
    { name: "channelId", type: "uint256" },
    { name: "requestId", type: "bytes32" },
    { name: "units",     type: "uint256" },
    { name: "deadline",  type: "uint256" },
  ],
} as const;
