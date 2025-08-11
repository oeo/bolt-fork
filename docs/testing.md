# Testing strategy

## Test levels

### Unit tests (`tests/unit/`)
- Test individual functions and classes
- No external dependencies
- Mock storage and network
- Run instantly
- **Coverage**: All core modules, crypto, storage, services, consensus
- **320+ total tests across all suites - 100% passing**
- **New consensus tests**: median time validation during reorganization

### Integration tests (`tests/integration/`)
- Test component interactions
- Use real Redis (via Docker)
- Test storage adapters
- Test crypto operations
- **Tests completed**:
  - Full transaction flow from creation to confirmation
  - Double-spend prevention validation
  - Transaction fee distribution to miners
  - Multi-block consistency
  - Mempool transaction prioritization
  - Nonce tracking across multiple transactions

### End-to-end tests (`tests/e2e/`)
- Test full node lifecycle
- Multi-node scenarios
- Network synchronization
- Fork resolution
- **Simulation tests completed**:
  - Basic money transfer between users
  - Multiple concurrent transactions
  - Double-spend prevention
  - Concurrent miners simulation
  - Miner rewards calculation
  - Chain reorganization handling
  - **Advanced reorganization scenarios with median time validation**
  - **Pre-validation of competing chains before reorganization**
  - High transaction volume processing (10+ actors)
  - Nonce tracking with pending transactions
  - Mining pool GBT integration

### Multi-node integration tests
- Each node runs in separate docker-compose file to avoid port conflicts
- Individual node directories: `docker/node1/`, `docker/node2/`, `docker/node3/`
- Each node has its own Redis and IPFS instance
- Test scripts orchestrate multi-node scenarios
- Validates IPFS peer discovery and HTTP data exchange

**Working features:**
- Nodes successfully start and discover each other via IPFS
- Mining nodes produce valid blocks independently
- BigInt serialization working correctly in Redis storage
- Peer discovery announcements via IPFS pubsub
- HTTP synchronization between nodes
- Block propagation across network
- Automatic sync service

**Known issues:**
- Nodes create competing forks when mining simultaneously
- Each miner stays on its own fork (no consensus)
- Missing cumulative difficulty-based chain selection

**Needs testing after consensus implementation:**
- Fork resolution between multiple miners
- Chain reorganization mechanics
- Convergence time measurement
- Deep reorganization limits
- Attack scenario simulations

### BATS tests (`tests/bats/`)
- Deployment testing  
- Docker container orchestration
- System-level validation

## Running tests

```bash
# all tests
bun test

# specific suite
bun test tests/unit
bun test tests/integration

# specific file
bun test tests/unit/hash.test.ts

# watch mode
bun --watch test
```

## Writing tests

### Basic structure
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

describe('Component', () => {
  let instance: Component;
  
  beforeAll(() => {
    instance = new Component();
  });
  
  afterAll(async () => {
    await instance.cleanup();
  });
  
  it('should do something', () => {
    const result = instance.doSomething();
    expect(result).toBe(expected);
  });
});
```

### Testing async code
```typescript
it('should handle async operations', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

### Testing storage
```typescript
describe('Storage', () => {
  let storage: StorageAdapter;
  
  beforeAll(() => {
    // use memory adapter for tests
    storage = new MemoryAdapter();
  });
  
  it('should save and retrieve blocks', async () => {
    const block = createTestBlock();
    await storage.saveBlock(block);
    const retrieved = await storage.getBlock(block.index);
    expect(retrieved).toEqual(block);
  });
});
```

## Test data factories

Create consistent test data:
```typescript
export function createTestBlock(overrides = {}): Block {
  return {
    index: 0,
    timestamp: Date.now(),
    previousHash: '0'.repeat(64),
    hash: '',
    merkleRoot: '',
    difficulty: 10,
    nonce: 0,
    transactions: [],
    ...overrides
  };
}
```

## Coverage

Check test coverage:
```bash
bun test --coverage
```

## CI/CD

Tests run automatically on:
- Every commit
- Pull requests
- Before deployment

## Key improvements from comprehensive testing

### Bug fixes discovered and resolved
1. **Mempool nonce ordering**: Fixed transaction sorting to prioritize nonce order for same-sender transactions
2. **Block template format**: Corrected template structure to properly include coinbase transactions
3. **Pending nonce tracking**: Implemented actor-level pending nonce management for simulation tests
4. **State validation**: Added temporary state tracking during block validation for multiple transactions
5. **Mining loop**: Enhanced to continue processing until mempool is empty
6. **Timestamp handling**: Fixed timestamp issues for rapid block creation in tests

### Test infrastructure improvements
- Added BlockchainActor class for realistic user simulation
- Implemented Miner class for testing concurrent mining scenarios
- Enhanced test logging for better debugging
- Added deterministic transaction sorting in mempool
- Improved fee calculation and balance verification