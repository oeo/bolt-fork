# bolt architecture

## overview

bolt is a proof-of-work blockchain using an account model (not utxo) with a clean separation between peer discovery and data exchange:

1. **ipfs layer**: used exclusively for peer discovery via pubsub
2. **tcp layer**: handles all blockchain data exchange using binary protocol

this architecture provides high performance binary communication while maintaining decentralized peer discovery through ipfs.

## consensus mechanism

bolt implements nakamoto consensus with proof-of-work:
- **cumulative difficulty**: follows chain with most total work
- **automatic reorganization**: switches to better chain when found
- **fork tolerance**: handles temporary forks with eventual convergence
- **orphan management**: stores blocks awaiting parents
- **median time validation**: ensures proper timestamp ordering

### key consensus features
- pre-validation of entire competing chains before reorganization
- deterministic fork resolution using cumulative work
- proper median time calculation during reorganization
- comprehensive test coverage for edge cases

## networking architecture

### two-layer design

```
┌─────────────────────────────────────────────────────┐
│                 application layer                   │
│           (blockchain, mining, mempool)             │
└─────────────────────────────────────────────────────┘
                          ▲
                          │
┌─────────────────────────────────────────────────────┐
│              tcp communication layer                │
│   • binary protocol with magic bytes                │
│   • headers-first synchronization                   │
│   • parallel block downloads                        │
│   • inventory management                            │
│   • transaction relay                               │
└─────────────────────────────────────────────────────┘
                          ▲
                          │
┌─────────────────────────────────────────────────────┐
│             ipfs peer discovery layer               │
│   • peer endpoint announcements                     │
│   • pubsub topic: /bolt/peers                       │
│   • automatic peer connection                       │
│   • bootstrap node fallback                         │
└─────────────────────────────────────────────────────┘
```

### tcp protocol

binary message format:
```
[magic(4)][type(4)][length(4)][checksum(4)][payload]
```

message types:
- `version` - handshake and capability exchange
- `verack` - version acknowledgement
- `ping/pong` - connection keepalive
- `inv` - inventory announcements
- `getdata` - request specific items
- `getblocks` - request block inventory
- `getheaders` - request header chain
- `headers` - header chain response
- `block` - full block data
- `tx` - transaction data

### synchronization strategy

headers-first sync with parallel downloads:
1. request headers from peers (getheaders)
2. validate header chain before downloading blocks
3. queue blocks for parallel download (max 16 concurrent)
4. handle out-of-order blocks via orphan pool
5. connect orphans when parents arrive

## storage layer

### lmdb backend

primary storage using lightning memory-mapped database:
- single environment for all databases
- atomic transactions across operations
- 100gb default capacity
- native bun integration for performance

databases:
- `blocks` - full block data by height and hash
- `headers` - block headers for fast sync
- `transactions` - indexed transaction storage
- `state` - account balances and nonces
- `mempool` - unconfirmed transactions with indexes
- `metadata` - chain tips and configuration

### storage abstraction

adapter pattern for flexibility:
```typescript
interface StorageAdapter {
  saveBlock(block: Block): Promise<void>;
  getBlock(height: number): Promise<Block | null>;
  getAccountState(address: string): Promise<AccountState | null>;
  // ... other methods
}
```

implementations:
- `LMDBAdapter` - production storage with persistence
- `MemoryAdapter` - in-memory for testing

## account model

instead of bitcoin's utxo model, bolt uses accounts with:
- address (bitcoin-style base58)
- balance (in watts, 1 bolt = 100,000,000 watts)
- nonce (for replay protection)

state is derived from the transaction history and cached in storage.

## key design decisions

### dynamic hashing algorithm

supports multiple proof-of-work algorithms:
- sha-256 (default)
- sha-512
- scrypt
- double-sha-256

the algorithm is part of chain configuration and included in the chain version hash.

### chain version hash

deterministic hash of configuration parameters:
- network (mainnet/testnet/devnet)
- hash algorithm
- difficulty parameters
- economic parameters (supply, rewards, halving)

prevents cross-chain contamination.

### hd wallet support

hierarchical deterministic wallets using bip44:
- derivation path: `m/44'/1057'/account'/change/index`
- coin type 1057 (bolt's registered type)
- mnemonic seed phrases (bip39)
- extended keys (bip32)

## directory structure

```
src/
├── core/           # blockchain, blocks, transactions, mempool
├── crypto/         # hashing, addresses, signatures, hd wallets
├── storage/        # lmdb and memory adapters
├── network/        # tcp protocol, sync, peer discovery
├── services/       # mining, metrics, sync
├── api/            # rest api server
├── config/         # chain configurations
│   └── chains/     # network-specific configs
├── utils/          # logger, bigint, identity
└── constants.ts    # protocol constants
```

## key components

### core
- `Blockchain` - chain management and validation
- `Mempool` - transaction pool with fee sorting
- `Block` - block structure and validation
- `Transaction` - transaction signing and verification

### network
- `Protocol` - binary message serialization/deserialization
- `ConnectionManager` - tcp connection handling
- `SyncManager` - blockchain synchronization
- `PeerDiscoveryService` - ipfs-based peer discovery
- `InventoryManager` - track peer inventory
- `TransactionRelay` - transaction propagation
- `OrphanPool` - out-of-order block handling
- `BlockDownloader` - parallel block fetching

### services
- `GetBlockTemplate` - mining pool protocol (gbt)
- `MiningService` - internal mining with workers
- `MetricsService` - prometheus metrics collection

### api
- `ApiServer` - rest api with full blockchain access

## performance optimizations

### bun-specific enhancements
- `Bun.CryptoHasher` for 2x faster hashing
- `Bun.listen` for high-performance tcp server
- native `Uint8Array` operations
- zero dependencies where possible

### protocol optimizations
- binary protocol reduces bandwidth
- headers-first sync minimizes downloads
- parallel block fetching (16 concurrent)
- inventory deduplication
- connection pooling (125 max peers)

### storage optimizations
- memory-mapped i/o via lmdb
- atomic batch operations
- indexed queries for fast lookups
- composite keys for complex queries

## monitoring and observability

### prometheus metrics (60+)
- blockchain: height, difficulty, reorganizations
- network: peers, messages, bandwidth
- mempool: size, fees, transaction flow
- storage: operations, latency, size
- mining: hashrate, blocks found, revenue

### logging
domain-based logging with automatic context:
```typescript
const logger = getLogger(__filename);
logger.info('block added', { height, hash });
```

### grafana dashboards
pre-configured dashboards for:
- node health and performance
- network topology and sync status
- mining statistics
- mempool analysis

## security considerations

### network security
- message checksums prevent corruption
- magic bytes prevent cross-chain messages
- connection limits prevent dos
- peer banning for misbehavior (planned)

### consensus security
- cumulative proof-of-work prevents attacks
- median time validation prevents timestamp manipulation
- reorganization depth limits (planned)
- checkpoint system (planned)

### storage security
- atomic transactions prevent corruption
- backup/recovery mechanisms
- integrity checks on startup

## future enhancements

### planned features
- peer reputation scoring
- partial chain validation
- state snapshots for fast sync
- bloom filters for spv clients
- compact block relay
- tor/i2p support

### scalability improvements
- block pruning for light clients
- sharding for horizontal scaling
- layer 2 solutions
- zero-knowledge proofs