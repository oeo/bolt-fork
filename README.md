# bolt

`bolt` is a proof-of-work blockchain with an account-based model, built with bun and typescript for maximum performance.

## Currency

- **Symbol**: BOLT
- **Base unit**: watt (W)
- **Precision**: 1 BOLT = 100,000,000 watts (8 decimal places)
- **Max supply**: 21,000,000 BOLT (2.1 quadrillion watts)
- **Initial reward**: 50 BOLT per block
- **Halving**: Every 210,000 blocks

## Current Status

**Production-ready features**:
- ✅ Complete proof-of-work consensus with cumulative difficulty
- ✅ Account-based model with nonce tracking
- ✅ TCP networking with IPFS peer discovery
- ✅ Headers-first blockchain synchronization
- ✅ Advanced chain reorganization with pre-validation
- ✅ Median time validation and timestamp ordering
- ✅ High-performance LMDB storage backend
- ✅ GetBlockTemplate (GBT) mining protocol
- ✅ HD wallet support (BIP32/BIP39/BIP44)
- ✅ Comprehensive metrics with Prometheus
- ✅ Docker-based multi-node deployment
- ✅ 368 passing tests with full coverage

**Recent improvements (January 2025)**:
- Fixed critical getblocks protocol bug enabling proper sync
- Removed Redis dependency in favor of pure LMDB storage
- Eliminated unused worker pool and legacy network components
- Simplified architecture from 50+ files to 46 focused modules
- TCP-only networking with IPFS used solely for peer discovery
- All tests passing with clean, maintainable codebase

## Quick Start

### Single Node Development
```bash
# start development environment
docker-compose up -d

# view logs
docker-compose logs -f

# stop services
docker-compose down
```

### Multi-Node Cluster
```bash
# launch 3-node cluster
bun run scripts/launch-cluster.ts 3

# launch 5-node cluster with clean data
bun run scripts/launch-cluster.ts 5 --clean

# stop cluster
bun run scripts/stop-cluster.ts 3
```

## Architecture

### Core Components

**Blockchain**
- Proof-of-work consensus with SHA-256
- Account model with balance and nonce tracking
- Bitcoin-style base58 addresses
- HD wallet derivation: `m/44'/1057'/account'/change/index`
- Cumulative difficulty chain selection

**Storage**
- LMDB as primary storage backend (100GB default capacity)
- Atomic transactions across all databases
- High-performance native Bun integration
- Optional memory adapter for testing

**Networking**
```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     Node 1      │     │     Node 2      │     │     Node 3      │
│                 │     │                 │     │                 │
│ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │
│ │ TCP Server  │◄├─────┤►│ TCP Client  │◄├─────┤►│ TCP Client  │ │
│ │ Port 8333   │ │     │ │             │ │     │ │             │ │
│ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │
│                 │     │                 │     │                 │
│ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │
│ │    IPFS     │ │     │ │    IPFS     │ │     │ │    IPFS     │ │
│ │ (Discovery) │◄├─────┤►│ (Discovery) │◄├─────┤►│ (Discovery) │ │
│ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

- **TCP Protocol**: Binary protocol for all blockchain data exchange
- **IPFS**: Used ONLY for peer discovery via pubsub
- **Sync**: Headers-first synchronization with parallel block downloads
- **Inventory**: Efficient block/transaction announcement system

### Services and Ports

**Node Services**
- API Server: `7333` (REST API)
- TCP P2P: `8333` (Binary protocol)
- Metrics: `7336` (Prometheus endpoint)
- IPFS: `5001` (Peer discovery only)

**Infrastructure** (when using Docker)
- Grafana: `3001-3005` (one per node)
- Prometheus: `9091-9095` (one per node)
- Loki: `3101-3105` (logging)

## API Endpoints

Core endpoints (see [docs/api.md](docs/api.md) for full documentation):

- `GET /` - Node status and network info
- `GET /blocks` - Recent blocks (paginated)
- `GET /blocks/:id` - Get block by height or hash
- `POST /transactions` - Submit transaction
- `GET /accounts/:address` - Account balance and nonce
- `GET /mempool` - Current mempool transactions
- `GET /mining/template` - GetBlockTemplate for miners

## Development

### Requirements
- Bun 1.0+ (no Node.js required)
- Docker & Docker Compose
- 2GB RAM minimum
- 10GB disk space

### Testing
```bash
# run all tests
bun test

# run unit tests only
bun test tests/unit

# run integration tests
bun test tests/integration

# run specific test file
bun test tests/unit/protocol.test.ts
```

### Project Structure
```
src/
├── core/           # blockchain, mempool, transactions
├── crypto/         # signatures, addresses, hashing
├── storage/        # lmdb and memory adapters
├── network/        # tcp protocol, sync, peer discovery
├── api/            # rest api server
├── services/       # mining, metrics, sync
├── config/         # chain configurations
└── utils/          # logging, bigint, identity
```

## Configuration

### Network Selection
Set `BOLT_NETWORK` environment variable:
- `mainnet` - Production network
- `testnet` - Test network with faster blocks
- `devnet` - Local development (minimal difficulty)

### Environment Variables
```bash
# Network
BOLT_NETWORK=devnet
NETWORK_MODE=tcp

# Storage
STORAGE_TYPE=lmdb
LMDB_PATH=/data/lmdb
LMDB_MAP_SIZE=107374182400  # 100GB

# Services
API_PORT=7333
TCP_PORT=8333
METRICS_PORT=7336

# Mining
ENABLE_MINING=true
MINER_ADDRESS=<your-address>

# Logging
LOG_LEVEL=info
```

## Mining

Bolt implements GetBlockTemplate (GBT) protocol for mining pool compatibility:

```javascript
// get block template
const template = await fetch('http://localhost:7333/mining/template').then(r => r.json());

// submit solution
const result = await fetch('http://localhost:7333/mining/submit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    templateId: template.templateId,
    nonce: foundNonce,
    timestamp: template.timestamp
  })
});
```

## Monitoring

Comprehensive Prometheus metrics available at `/metrics`:

- **Blockchain**: height, difficulty, reorganizations
- **Network**: peer count, messages sent/received
- **Mempool**: size, fees, transaction flow
- **Storage**: operation latency, database size
- **Mining**: hashrate, blocks found, revenue

Access Grafana dashboards at `http://localhost:3001` (admin/admin) when running with Docker.

## License

MIT