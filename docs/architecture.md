# bolt architecture

## Overview

bolt is a proof-of-work blockchain using an account model (not UTXO) with a simplified two-layer networking architecture:

1. **IPFS Layer**: Used exclusively for peer discovery and endpoint announcements
2. **HTTP Layer**: Handles all blockchain data exchange between discovered peers

This architecture provides the reliability and simplicity of HTTP while maintaining decentralized peer discovery through IPFS.

## Consensus Mechanism

bolt implements nakamoto consensus with proof-of-work:
- **cumulative difficulty**: follows chain with most total work
- **automatic reorganization**: switches to better chain when found
- **fork tolerance**: handles temporary forks with eventual convergence
- **orphan management**: stores blocks awaiting parents

### key consensus components
- `ForkManager`: tracks competing chains and their cumulative work
- `handleCompetingBlock()`: processes blocks from different forks
- `reorganize()`: performs chain reorganization to better fork
- storage layer tracks cumulative difficulty for chain selection

## Networking Architecture

### Two-Layer Design

```
┌─────────────────────────────────────────────────────┐
│                 Application Layer                   │
│           (Blockchain, Mining, Mempool)             │
└─────────────────────────────────────────────────────┘
                          ▲
                          │
┌─────────────────────────────────────────────────────┐
│              HTTP Communication Layer               │
│   • Block synchronization                           │
│   • Transaction propagation                         │
│   • Peer status exchange                            │
│   • Direct peer-to-peer data transfer               │
└─────────────────────────────────────────────────────┘
                          ▲
                          │
┌─────────────────────────────────────────────────────┐
│             IPFS Peer Discovery Layer               │
│   • Peer endpoint announcements                     │
│   • Node capability advertisement                   │
│   • Network topology discovery                      │
│   • Bootstrap node connections                      │
└─────────────────────────────────────────────────────┘
```

### IPFS Discovery Protocol

Nodes use IPFS pubsub to announce their capabilities:
```json
{
  "nodeId": "node-1",
  "httpUrl": "http://node-1:7333", 
  "capabilities": ["mining", "full_node"],
  "chainHash": "abc123...",
  "blockHeight": 1250,
  "timestamp": 1704067200
}
```

### HTTP Data Exchange

All blockchain data flows over HTTP:
- `GET /peer/status` - Node status and chain info
- `GET /peer/blocks?height=X` - Block synchronization
- `POST /peer/blocks` - Block propagation
- `GET /peer/transactions` - Mempool sync
- `POST /peer/transactions` - Transaction broadcast

**Current status**: HTTP endpoints implemented and working. Nodes successfully sync blocks via HTTP.

## Consensus Mechanism (In Development)

### Cumulative Proof-of-Work

bolt will follow the standard proof-of-work consensus rule: **follow the chain with the most cumulative work**.

**Current Issue**: When multiple miners create blocks simultaneously, they form competing chains (forks). Each miner continues on its own fork, preventing network consensus.

**Planned Solution**:
1. **Cumulative Difficulty Tracking**: Each block will track the total cumulative difficulty of its chain
2. **Chain Selection**: Nodes will follow the chain with highest cumulative work, not just the longest
3. **Automatic Reorganization**: When a better chain is discovered, nodes will reorganize to follow it
4. **Fork Tolerance**: Temporary forks are expected and will resolve naturally as one chain accumulates more work

### Chain Reorganization Process

When a node discovers a chain with more cumulative work:
1. Find the common ancestor block between chains
2. Revert local chain back to the ancestor
3. Apply blocks from the better chain
4. Update all state (accounts, mempool, etc.)
5. Continue mining on the new chain tip

### Safety Mechanisms

- **Maximum Reorg Depth**: Limit reorganizations to prevent deep chain attacks (e.g., 100 blocks)
- **Checkpoint System**: Finalize blocks after certain depth
- **Fork Monitoring**: Track and log all reorganization attempts

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
├── services/       # mining, getblocktemplate, metrics, sync
├── network/        # p2p networking, peer management
├── api/           # REST API server
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
- **Sync** (`services/sync.ts`): Blockchain synchronization and chain reorganization

### Network layer
- **IPFSService** (`network/ipfs.ts`): IPFS client for peer discovery only
- **PeerManager** (`network/peer-manager.ts`): HTTP peer connection management
- **Messages** (`network/messages.ts`): HTTP message types with bigint support

### API layer
- **ApiServer** (`api/server.ts`): REST API with blockchain endpoints + peer-to-peer HTTP endpoints

### Storage adapters
- **Redis** (`storage/redis.ts`): Production storage with persistence
- **Memory** (`storage/memory.ts`): In-memory storage for testing
- **Abstract** (`storage/adapter.ts`): Base class defining storage interface

### Monitoring and observability
- **Metrics service**: 60+ Prometheus metrics covering all aspects
- **Metrics server**: HTTP endpoint for Prometheus scraping
- **Helper utilities**: Timing and recording utilities
- **Integration ready**: Hooks for blockchain, mempool, mining, and API metrics