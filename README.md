# bolt

`bolt` is a proof-of-work blockchain with an account-based model, using "watts" as its base unit.

## Currency

- **Symbol**: BOLT
- **Base unit**: watt (W)
- **Precision**: 1 BOLT = 100,000,000 watts (8 decimal places)
- **Max supply**: 21,000,000 BOLT (2.1 quadrillion watts)
- **Initial reward**: 50 BOLT per block
- **Halving**: Every 210,000 blocks

## Current status

- ✅ Phase 0: Docker environment setup
- ✅ Phase 1: Core foundation (blockchain, storage, cryptography)
- ✅ Phase 2: Transaction ecosystem (mempool, HD wallets, signatures)
- ✅ Phase 3: Mining service with GetBlockTemplate (GBT) protocol
- ✅ Phase 4: Monitoring and metrics (Prometheus integration)
- ✅ Phase 4.5: Comprehensive testing
- ✅ Phase 5: Multi-node Docker infrastructure with IPFS peer discovery
- ✅ Phase 6: HTTP peer-to-peer blockchain synchronization
- ✅ Phase 7: Cumulative proof-of-work consensus mechanism
- ✅ Phase 7.5: Advanced reorganization and consensus improvements (COMPLETED!)
- 📋 Phase 8: Peer discovery optimization and state management
- 📋 Phase 9: Production deployment and optimization

**Working features**:
- **ROBUST CONSENSUS SYSTEM!** Advanced chain reorganization with pre-validation
- **MEDIAN TIME VALIDATION FIXED!** Proper timestamp ordering during reorganization
- Cumulative proof-of-work consensus with hash-based tie-breaking
- Complete chain pre-validation before reorganization attempts
- Specialized block validation during reorganization process
- Comprehensive reorganization test coverage
- Fork detection and management with deterministic resolution
- Multi-node mining with separate Docker environments
- IPFS-based peer discovery
- HTTP-based blockchain synchronization
- Automatic peer-to-peer sync service
- BigInt-safe Redis storage
- Block broadcasting between nodes

**Recent improvements (2025-08-11)**:
- Fixed reorganization failures due to median time validation errors
- Added pre-validation of entire competing chains before reorganization
- Implemented correct past block selection for median time during reorg
- Created comprehensive test suite for reorganization edge cases
- Enhanced blockchain validation with proper timestamp ordering
- All consensus tests passing with robust reorganization handling

**Outstanding issues**:
- Peer cumulative difficulty occasionally shows as "undefined" in logs
- Need to implement partial chain download handling
- Peer discovery retry logic needs improvement

**Next priorities**:
- Fix undefined cumulative difficulty from IPFS-discovered peers
- Implement efficient partial chain downloads
- Add peer banning and reputation scoring
- State management improvements for reorganization
- Deep reorganization limits and safety mechanisms

## Quick start

### Single node development
```bash
# start the development environment
docker-compose up -d

# view logs
docker-compose logs -f

# stop services
docker-compose down
```

### Multi-node testing
```bash
# start all 3 nodes with orchestration script
./scripts/test-multinode.sh start

# check node status
./scripts/test-multinode.sh status

# view logs from all nodes
./scripts/test-multinode.sh logs

# stop all nodes
./scripts/test-multinode.sh stop
```

## Services

### Infrastructure
- Redis: `localhost:7337`
- Prometheus: `localhost:7338`
- Loki: `localhost:7339`
- Grafana: `localhost:7340` (admin/admin)

### Bolt services (single node)
- API Server: `localhost:7333` (REST API + Peer Communication)
- IPFS Node: `localhost:5001` (Peer Discovery Only)
- Metrics: `localhost:7336` (Prometheus endpoint)

### Multi-node setup
- Node 1: API `localhost:7333`, IPFS `localhost:5001`
- Node 2: API `localhost:7343`, IPFS `localhost:5011`  
- Node 3: API `localhost:7353`, IPFS `localhost:5021`

## Architecture

### Blockchain
- **Consensus**: Proof-of-work with cumulative difficulty (highest work wins)
- **Account model**: Balance and nonce tracking (no UTXOs)
- **Address format**: Bitcoin-style base58 addresses with HD key support
- **HD derivation**: BIP44 path `m/44'/1057'/account'/change/index` (coin type 1057)
- **Storage**: Redis with swappable adapters (memory, redis, future: leveldb)

### Simplified Networking Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│     node-1      │    │     node-2      │    │     node-3      │
│                 │    │                 │    │                 │
│ ┌─────────────┐ │    │ ┌─────────────┐ │    │ ┌─────────────┐ │
│ │ HTTP Server │◄┼────┼─┤ HTTP Client │ │    │ │ HTTP Client │ │
│ │ Port 7333   │ │    │ │             │◄┼────┼─┤ Port 7353   │ │
│ └─────────────┘ │    │ └─────────────┘ │    │ └─────────────┘ │
│        │        │    │        │        │    │        │        │
│ ┌─────────────┐ │    │ ┌─────────────┐ │    │ ┌─────────────┐ │
│ │ IPFS Client │ │    │ │ IPFS Client │ │    │ │ IPFS Client │ │
│ │  Discovery  │ │────┼──│  Discovery  │ │────┼──│  Discovery  │ │
│ └─────────────┘ │    │ └─────────────┘ │    │ └─────────────┘ │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │  IPFS Network   │
                    │ (Peer Discovery)│
                    └─────────────────┘
```

- **IPFS Layer**: Used ONLY for peer discovery and endpoint announcements
- **HTTP Layer**: Direct peer-to-peer blockchain data exchange (blocks, transactions, sync)
- **Peer Discovery**: Nodes announce their HTTP endpoints via IPFS pubsub
- **Data Exchange**: All blockchain data flows over standard HTTP between discovered peers
- **Benefits**: Simple debugging, reliable connections, faster sync, clear separation of concerns
### Mining
- **Mining**: GetBlockTemplate (GBT) protocol for mining pool compatibility
- **Runtime**: Bun (TypeScript runs directly, no compilation)

## Features

### Completed
- Full proof-of-work blockchain with account model
- Transaction signing and verification (secp256k1)
- HD wallet support (BIP32/BIP39/BIP44)
- Mining with GetBlockTemplate protocol
- Comprehensive metrics (60+ Prometheus metrics)
- IPFS-based peer discovery system
- REST API with full blockchain access
- Docker development environment
- 330+ unit and integration tests

### API endpoints
See [docs/api.md](docs/api.md) for full API documentation.

Key endpoints:
- `GET /blockchain/info` - Chain statistics
- `POST /transactions` - Submit transactions
- `GET /accounts/:address/balance` - Check balances
- `GET /network/status` - P2P network info

### Demo scripts
- `scripts/demo.ts` - Basic blockchain demo
- `scripts/p2p-demo.ts` - Multi-node P2P simulation
- `scripts/generate-wallet.ts` - HD wallet generation

## Development

See [plan.md](plan.md) for the detailed implementation roadmap.

## Configuration

Bolt uses a two-tier configuration system:

### Chain Configuration
Consensus parameters are defined in TypeScript files under `src/config/chains/`:
- `mainnet.ts` - Production network configuration
- `testnet.ts` - Test network with faster blocks
- `devnet.ts` - Local development with minimal difficulty

Select network via `BOLT_NETWORK` environment variable (default: mainnet).

### Operational Settings
Node operation settings via environment variables:
- `BOLT_NETWORK` - Network to use (mainnet/testnet/devnet)
- `STORAGE_TYPE` - Storage backend (redis/memory)
- `REDIS_URL` - Redis connection string
- `API_PORT`, `P2P_PORT`, `WS_PORT` - Service ports
- `LOG_LEVEL` - Logging verbosity
- `ENABLE_MINING` - Enable/disable mining
- `MINER_ADDRESS` - Address for mining rewards

## Mining

Bolt implements the GetBlockTemplate (GBT) protocol for mining pool compatibility:

### Features
- Standard GBT block template structure
- Redis-based template caching with automatic expiry
- Longpoll support for efficient mining operations
- Mempool monitoring for automatic template refresh
- Block submission validation

### Mining API
```typescript
// Get a block template for mining
const template = await gbtService.getBlockTemplate();

// Submit a mined block
const submission = {
  templateId: template.templateId,
  nonce: foundNonce,
  timestamp: template.timestamp
};
const result = await gbtService.submitBlock(submission);
```

## Monitoring

Bolt includes comprehensive Prometheus metrics for observability:

### Metrics Categories
- **Blockchain**: Height, difficulty, blocks mined, validation errors
- **Mempool**: Size, fees, transaction flow
- **Mining**: Hash rate, success rate, revenue
- **GBT**: Template management, longpoll connections
- **Storage**: Operation latency, errors
- **Network**: Peer counts, bandwidth (ready for P2P)
- **API**: Request metrics (ready for REST API)

### Running the Metrics Server
```bash
bun run scripts/metrics-server.ts
# Metrics available at http://localhost:7336/metrics
```

## Testing

```bash
bun test              # all tests
bun test:unit         # unit tests only
bun test:integration  # integration tests
bun test tests/unit/metrics.test.ts   # metrics tests
bun test tests/unit/getblocktemplate.test.ts  # GBT tests
```
