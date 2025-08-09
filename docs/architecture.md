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
├── core/           # blockchain, blocks, transactions, mempool
├── crypto/         # hashing, addresses, signatures
├── storage/        # storage adapters (redis, memory)
├── services/       # mining, getblocktemplate, metrics
├── network/        # p2p networking (future)
├── api/           # REST and WebSocket (future)
├── config/        # chain configs and constants
│   └── chains/    # network-specific configurations
├── utils/         # logger, currency, bigint serialization
└── types.ts       # all TypeScript interfaces
```

## Key components

### Services
- **GetBlockTemplate** (`services/getblocktemplate.ts`): Mining pool protocol implementation
- **Mining** (`services/mining.ts`): Internal mining service
- **Metrics** (`services/metrics.ts`): Comprehensive Prometheus metrics collection

### Storage adapters
- **Redis** (`storage/redis.ts`): Production storage with persistence
- **Memory** (`storage/memory.ts`): In-memory storage for testing
- **Abstract** (`storage/adapter.ts`): Base class defining storage interface

### Monitoring and observability
- **Metrics service**: 60+ Prometheus metrics covering all aspects
- **Metrics server**: HTTP endpoint for Prometheus scraping
- **Helper utilities**: Timing and recording utilities
- **Integration ready**: Hooks for blockchain, mempool, mining, and API metrics