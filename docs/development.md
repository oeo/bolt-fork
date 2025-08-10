# Development guide

## Prerequisites

- Bun runtime (no TypeScript compilation needed)
- Docker and Docker Compose
- Redis (via Docker)
- IPFS (via Docker)

## Getting started

### Single node development
```bash
# install dependencies
bun install

# start docker services (single node)
docker-compose up -d

# run tests
bun test

# run specific test suite
bun test:unit
bun test:integration
```

### Multi-node development
```bash
# install dependencies
bun install

# start all nodes for testing
./scripts/test-multinode.sh start

# check node status and blockchain height
./scripts/test-multinode.sh status

# view logs from all nodes
./scripts/test-multinode.sh logs

# stop all nodes
./scripts/test-multinode.sh stop

# run multi-node tests
bun test tests/e2e/multi-node.test.ts
```

## Project structure

- `src/` - TypeScript source code
- `tests/` - Test files (unit, integration, e2e, bats)
- `docs/` - Technical documentation
- `monitoring/` - Grafana, Prometheus, Loki configs
- `scripts/` - Utility scripts

## Testing

Tests use Bun's built-in test runner:

```typescript
import { describe, it, expect } from 'bun:test';

describe('Feature', () => {
  it('should work', () => {
    expect(1 + 1).toBe(2);
  });
});
```

## Logging

Use domain-based logging:
```typescript
import { getLogger } from '../logger';

const logger = getLogger(__filename);
logger.info('Hello from core domain');
```

## Storage

Always use the storage adapter interface:
```typescript
class RedisAdapter implements StorageAdapter {
  async saveBlock(block: Block): Promise<void> {
    // implementation
  }
}
```

## Configuration

Environment variables (no dotenv needed with Bun):
- `BOLT_NETWORK` - Network type (mainnet/testnet/local)
- `STORAGE_TYPE` - Storage backend (redis/memory/leveldb)
- `LOG_LEVEL` - Logging level (info/debug/error)
- `HASH_ALGORITHM` - PoW algorithm (sha256/sha512/scrypt)

## Current development priority

**critical**: implement cumulative proof-of-work consensus mechanism to resolve the fork issue where multiple miners create competing chains. see `docs/consensus.md` for detailed plan.

## Architecture overview

bolt uses a simplified two-layer networking architecture:

1. **IPFS Layer**: Peer discovery and endpoint announcements only
2. **HTTP Layer**: All blockchain data exchange (blocks, transactions, sync)

This design provides:
- Simple debugging with standard HTTP tools
- Reliable peer-to-peer connections
- Fast synchronization between nodes
- Clear separation of concerns

## Docker services

### Single node setup
- Redis: `localhost:6379`
- API Server: `localhost:7333`
- IPFS: `localhost:5001`
- Prometheus: `localhost:7338`
- Loki: `localhost:7339`
- Grafana: `localhost:7340` (admin/admin)

### Multi-node setup
- Node 1: API `localhost:7333`, IPFS `localhost:5001`
- Node 2: API `localhost:7343`, IPFS `localhost:5011`
- Node 3: API `localhost:7353`, IPFS `localhost:5021`

## Common commands

```bash
# check redis connection
redis-cli -h localhost -p 7337 ping

# view logs
docker-compose logs -f

# restart services
docker-compose restart

# clean everything
docker-compose down -v
```