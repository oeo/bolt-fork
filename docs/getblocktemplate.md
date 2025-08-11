# GetBlockTemplate (GBT) protocol

## Overview

bolt implements the GetBlockTemplate protocol for mining pool compatibility, allowing external miners to efficiently mine blocks.

## Architecture

The GBT implementation consists of:

### Core service (`src/services/getblocktemplate.ts`)
- Template generation and caching
- Mempool monitoring for changes
- Longpoll support
- Block submission validation

### Storage integration
- Redis-based template caching with TTL
- Set operations for template management
- Custom data storage for service state

### Template structure
```typescript
interface BlockTemplate {
  // identification
  templateId: string;
  createdAt: number;
  expiresAt: number;
  
  // block data
  version: number;
  height: number;
  previousHash: string;
  merkleRootPlaceholder: string;
  timestamp: number;
  difficulty: number;
  
  // mining data
  target: string;  // 64-char hex string
  bits: string;    // compact difficulty
  
  // transaction data
  transactions: Transaction[];
  coinbaseTransaction: Transaction;
  coinbaseValue: bigint;
  totalFees: bigint;
  blockReward: bigint;
  
  // metadata
  transactionCount: number;
  blockSizeBytes: number;
  sigOpsCount: number;
  
  // longpoll
  longpollId: string;
  submitOld: boolean;
}
```

## Template lifecycle

1. **Generation**: Templates are created on demand or when mempool changes significantly
2. **Caching**: Stored in Redis with 30-second default expiry
3. **Refresh triggers**:
   - New block arrives (invalidates all templates)
   - Mempool changes >10% (fee or size)
   - Template expires naturally
   - Manual refresh request
4. **Cleanup**: Automatic cleanup of expired templates every 10 seconds

## Mempool monitoring

The service monitors the mempool for significant changes:
- Calculates hash of mempool state (size, fees, top transactions)
- Checks every 5 seconds for changes
- Triggers template refresh when change threshold exceeded

## Longpoll support

Allows miners to wait for new work efficiently:
- Clients provide `longpollId` from previous template
- If template unchanged, connection held open up to 60 seconds
- Returns immediately when new template available
- Reduces polling overhead for miners

## Block submission

When miners submit a solution:
1. Validate template ID exists and hasn't expired
2. Reconstruct block from template and submission
3. Validate proof of work against target
4. Submit to blockchain for inclusion

## Redis key structure

```
gbt:template:{id}        - template data (JSON)
gbt:active              - set of active template IDs
gbt:current             - current template ID
gbt:expires:{timestamp} - templates expiring at timestamp
gbt:mempool:hash        - current mempool state hash
gbt:longpoll:{id}       - longpoll tracking
gbt:stats               - service statistics
```

## Difficulty handling

### Target calculation
- Target = (2^256 - 1) / difficulty
- Ensures 64-character hex string output
- Handles edge case where difficulty = 1

### Devnet considerations
- Difficulty = 1 means target = 2^256 - 1
- Any hash is valid (useful for testing)
- All nonces produce valid blocks

## Performance optimizations

- Batch Redis operations with pipelines
- Efficient serialization with BigInt support
- Template reuse when mempool unchanged
- Lazy template generation

## Integration points

### Blockchain
- `getHeight()` - current chain height
- `getLatestBlock()` - previous block for linking
- `getDifficulty()` - current mining difficulty
- `getChainConfig()` - chain parameters
- `calculateBlockReward()` - block reward calculation

### Mempool
- `getTransactionsForBlock()` - sorted by fee
- `getStats()` - mempool statistics
- `getTransactions()` - all pending transactions

### Storage
- Custom data methods for template persistence
- Set operations for template management
- TTL support for automatic expiry

## Testing

Comprehensive test suite covers:
- Template generation and caching
- Mempool change detection
- Longpoll functionality
- Block submission validation
- Template lifecycle management
- Edge cases (difficulty = 1, empty mempool, etc.)

All 18 tests passing including:
- Merkle root calculation
- Fee aggregation
- Template expiry
- Cache invalidation

### E2E integration testing
- Mining pool scenario simulation
- Template refresh on transaction addition
- Successful block submission in devnet
- Integration with BlockchainActor and Miner classes

## Critical fixes from testing phase

1. **Template transaction structure**: Fixed to properly include coinbase transaction in the transactions array
2. **Nonce handling**: Enhanced to support pending nonce tracking for rapid transaction submission
3. **Template validation**: Improved to handle edge cases in devnet with difficulty=1
4. **Mempool integration**: Fixed transaction ordering to respect nonce sequences for same-sender transactions