# Development guide

## Prerequisites

- Bun runtime (no TypeScript compilation needed)
- Docker and Docker Compose
- Redis (via Docker)

## Getting started

```bash
# install dependencies
bun install

# start docker services
docker-compose up -d

# run tests
bun test

# run specific test suite
bun test:unit
bun test:integration
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

## Docker services

- Redis: `localhost:7337`
- Prometheus: `localhost:7338`
- Loki: `localhost:7339`
- Grafana: `localhost:7340` (admin/admin)

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