# block structure

## block header

```typescript
{
  index: number,              // block height (0 for genesis)
  timestamp: number,          // unix timestamp in milliseconds
  previousHash: string,       // hash of previous block (64 hex chars)
  hash: string,              // this block's hash (64 hex chars)
  merkleRoot: string,        // root of transaction merkle tree (64 hex chars)
  stateRoot: string,         // root of complete resulting account state
  difficulty: number,        // mining difficulty target
  nonce: number,             // proof-of-work nonce
  miner?: string            // optional metadata excluded from block hash
}
```

`miner` is excluded from block hashing. it remains part of serialized block size, so it can affect `maxBlockSize` validation.

## transactions array

```typescript
transactions: [
  {
    // index 0: coinbase transaction (required)
    chainId: number,          // chain that accepts this transaction
    kind: 'coinbase',
    hash: string,
    from: null,              // always null for coinbase
    to: string,              // reward recipient address
    amount: bigint,          // block reward + total fees
    nonce: 0,                // always 0 for coinbase
    fee: 0n,                 // always 0 for coinbase
    timestamp: number
  },
  {
    // index 1+: transfer transactions (optional)
    chainId: number,          // chain that accepts this transaction
    kind: 'transfer',
    hash: string,
    from: string,            // sender address
    to: string,              // recipient address
    amount: bigint,          // transfer amount in watts
    nonce: number,           // sender transaction count + 1
    fee: bigint,             // transaction fee in watts
    signature: string,       // ECDSA signature
    publicKey: string,       // sender public key
    timestamp: number
  }
]
```

## transaction identity

transfer signatures commit to the domain `bolt:transaction:v1`, chain id, kind, sender, recipient, amount, nonce, fee, and timestamp. each utf-8 field is length-prefixed. transfer hashes commit to the same canonical bytes and the signature. coinbase hashes commit to the canonical unsigned fields because coinbase transactions have no signature.

transactions from another chain are invalid. transfer `from` and `to` addresses must use the configured chain prefix. coinbase `to` addresses must also use that prefix.

## mining process

1. miner creates coinbase transaction with their address
2. coinbase is placed at `transactions[0]`
3. all transactions are hashed into merkle tree
4. transactions execute against parent account state
5. resulting complete account state is committed by state root
6. block header is hashed repeatedly with incrementing nonce
7. block is valid when hash meets difficulty target

## validation rules

- block hash must meet difficulty target
- `previousHash` must match previous block hash
- timestamp must be strictly greater than parent block timestamp
- timestamp must be greater than median of past 11 blocks
- timestamp cannot be more than 2 hours in future
- coinbase value must equal block reward + sum of transaction fees
- coinbase timestamp must equal block timestamp
- all transfer transactions must have valid signatures
- all transactions must match configured chain id
- transfer senders and recipients, and coinbase recipients, must match configured address prefix
- transaction nonces must be sequential per sender
- state root must match deterministic execution against parent state

## size limits

- total UTF-8 serialized block size must not exceed configured `maxBlockSize`. this is a consensus rule.
- `maxTransactionSize` defaults to 100,000 bytes. this is mempool policy, not a block validity rule.
- `minFeePerByte` is configured per network. this is mempool policy, not a block validity rule.
