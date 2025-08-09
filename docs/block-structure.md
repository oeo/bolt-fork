# Block structure

## Block header

```typescript
{
  index: number,              // Block height (0 for genesis)
  timestamp: number,          // Unix timestamp in milliseconds
  previousHash: string,       // Hash of previous block (64 hex chars)
  hash: string,              // This block's hash (64 hex chars)
  merkleRoot: string,        // Root of transaction merkle tree (64 hex chars)
  difficulty: number,        // Mining difficulty target
  nonce: number,             // Proof-of-work nonce
  chainVersionHash: string,  // Chain configuration hash (64 hex chars)
  miner?: string            // Miner's address (optional)
}
```

## Transactions array

```typescript
transactions: [
  {
    // Index 0: Coinbase transaction (required)
    hash: string,
    from: null,              // Always null for coinbase
    to: string,              // Miner's address
    amount: bigint,          // Block reward + total fees
    nonce: 0,                // Always 0 for coinbase
    fee: 0n,                 // Always 0 for coinbase
    timestamp: number
  },
  {
    // Index 1+: Regular transactions (optional)
    hash: string,
    from: string,            // Sender address
    to: string,              // Recipient address
    amount: bigint,          // Transfer amount in watts
    nonce: number,           // Sender's transaction count + 1
    fee: bigint,             // Transaction fee in watts
    signature: string,       // ECDSA signature
    publicKey: string,       // Sender's public key
    timestamp: number
  }
]
```

## Mining process

1. Miner creates coinbase transaction with their address
2. Coinbase placed at transactions[0]
3. All transactions hashed into merkle tree
4. Block header (including merkle root) hashed repeatedly with incrementing nonce
5. When hash meets difficulty target, block is valid

## Validation rules

- Block hash must meet difficulty target
- previousHash must match previous block's hash
- Timestamp must be greater than median of past 11 blocks
- Timestamp cannot be more than 2 hours in future
- Coinbase value must equal block reward + sum of transaction fees
- All transactions must have valid signatures (except coinbase)
- Transaction nonces must be sequential per sender

## Size limits

- Maximum block size: ~1MB (configurable)
- Maximum transaction size: 100KB
- Minimum transaction fee: 1 watt per byte