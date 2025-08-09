# bolt architecture

## Overview

bolt is a proof-of-work blockchain using an account model (not UTXO) with configurable hashing algorithms.

## Key design decisions

### Dynamic hashing algorithm

Unlike Bitcoin's hardcoded SHA-256, bolt supports multiple hashing algorithms:
- SHA-256
- SHA-512
- Scrypt
- Double-SHA-256

The algorithm is part of the chain configuration and included in the chain version hash, ensuring nodes on different algorithms cannot accidentally sync.

### Chain version hash

Every node calculates a deterministic hash of its configuration parameters:
- Network (mainnet/testnet/local)
- Hash algorithm
- Difficulty parameters
- Economic parameters (supply, rewards, halving)

This hash acts as a unique chain identifier, preventing cross-chain contamination.

### Storage abstraction

The storage layer uses an adapter pattern:
```typescript
interface StorageAdapter {
  saveBlock(block: Block): Promise<void>;
  getBlock(height: number): Promise<Block | null>;
  // ... other methods
}
```

This allows swapping between:
- Redis (development, fast)
- Memory (testing)
- LevelDB (production, scalable)

### Account model

Instead of Bitcoin's UTXO model, bolt uses accounts with:
- Address
- Balance (in watts, 1 BOLT = 100,000,000 watts)
- Nonce (for replay protection)

State is event-sourced from the transaction history.

### Logging

Dynamic domain-based logging using `getLogger()`:
```typescript
// Automatically gets 'core' logger
const logger = getLogger(__filename);
```

## Directory structure

```
src/
├── core/        # blockchain, blocks, transactions
├── crypto/      # hashing, addresses, signatures
├── storage/     # storage adapters
├── network/     # p2p networking (future)
├── services/    # mining, sync, metrics (future)
├── api/         # REST and WebSocket (future)
├── config/      # constants and configuration
└── utils/       # logger, currency formatting
```