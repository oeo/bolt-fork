# testing

bolt has comprehensive test coverage with 368 passing tests across unit and integration suites.

## test overview

```
total tests: 368
unit tests: 317
integration tests: 51
coverage: ~85%
```

## running tests

### all tests
```bash
bun test
```

### unit tests only
```bash
bun test tests/unit
```

### integration tests only
```bash
bun test tests/integration
```

### specific test file
```bash
bun test tests/unit/protocol.test.ts
```

### with bail on first failure
```bash
bun test --bail
```

## test structure

```
tests/
├── unit/
│   ├── address.test.ts        # address generation and validation
│   ├── block.test.ts          # block creation and validation
│   ├── blockchain.test.ts     # blockchain operations
│   ├── chain-config.test.ts   # configuration testing
│   ├── consensus.test.ts      # consensus rules and reorgs
│   ├── currency.test.ts       # currency calculations
│   ├── difficulty.test.ts     # difficulty adjustment
│   ├── getblocktemplate.test.ts # gbt protocol
│   ├── hash.test.ts           # hashing algorithms
│   ├── lmdb-storage.test.ts  # lmdb adapter
│   ├── mempool.test.ts        # mempool operations
│   ├── metrics.test.ts        # prometheus metrics
│   ├── mining.test.ts         # mining service
│   ├── protocol.test.ts       # tcp protocol messages
│   ├── signature.test.ts      # transaction signing
│   ├── storage.test.ts        # storage adapters
│   ├── transaction.test.ts    # transaction validation
│   └── types.test.ts          # type definitions
│
├── integration/
│   ├── api-only.test.ts      # api endpoints
│   ├── blockchain.test.ts    # multi-block scenarios
│   └── full-flow.test.ts     # end-to-end flows
│
└── setup.ts                   # test configuration
```

## unit tests

### core components
- **blockchain**: chain management, reorganization, validation
- **mempool**: transaction pool, fee sorting, eviction
- **block**: proof-of-work, merkle trees, validation
- **transaction**: signing, verification, serialization

### cryptography
- **addresses**: base58 encoding, checksums, validation
- **signatures**: secp256k1 signing and verification
- **hashing**: sha-256, sha-512, scrypt support
- **hd wallets**: bip32/bip39/bip44 derivation

### networking
- **protocol**: message serialization/deserialization
- **tcp messages**: all message types tested
- **checksum validation**: corruption detection
- **bigint handling**: proper serialization

### storage
- **lmdb adapter**: all database operations
- **memory adapter**: in-memory storage
- **atomic transactions**: batch operations
- **indexes**: composite key queries

### mining
- **getblocktemplate**: template generation and submission
- **mining service**: block production
- **difficulty adjustment**: target calculation
- **coinbase generation**: reward transactions

## integration tests

### full flow scenarios
- complete transaction lifecycle
- multi-party transfers
- double-spend prevention
- fee distribution
- nonce tracking

### blockchain scenarios
- multi-block chains
- fork resolution
- reorganization handling
- cumulative difficulty
- median time validation

### api testing
- rest endpoints
- error handling
- pagination
- bigint serialization

## test utilities

### fixtures
```typescript
// create test blockchain
const blockchain = await createTestBlockchain();

// generate test account
const account = generateTestAccount();

// create signed transaction
const tx = createTestTransaction(from, to, amount);
```

### mocking
```typescript
// mock storage
const storage = new MemoryAdapter();

// mock time
const clock = sinon.useFakeTimers();
```

### assertions
```typescript
// custom matchers
expect(block).toBeValidBlock();
expect(tx).toHaveValidSignature();
expect(chain).toHaveHeight(10);
```

## performance testing

### benchmarks
```bash
# run benchmarks
bun run benchmarks

# specific benchmark
bun run bench:mining
```

### metrics
- block validation: <10ms
- transaction signing: <1ms
- hash calculation: >1m hashes/sec
- storage operations: <1ms

## coverage

### current coverage
- core: 90%+
- crypto: 95%+
- storage: 85%+
- network: 80%+
- api: 75%+

### generating reports
```bash
# generate coverage report
bun test --coverage

# html report
bun test --coverage --coverage-reporter=html
```

## continuous integration

### github actions
```yaml
name: tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test
```

### docker testing
```bash
# run tests in docker
docker build -t bolt-test -f Dockerfile.test .
docker run bolt-test
```

## test guidelines

### writing tests
1. use descriptive test names
2. test one thing per test
3. use arrange-act-assert pattern
4. mock external dependencies
5. clean up after tests

### test organization
```typescript
describe('component', () => {
  beforeEach(() => {
    // setup
  });

  afterEach(() => {
    // cleanup
  });

  it('should do something', () => {
    // arrange
    const input = createInput();
    
    // act
    const result = component.process(input);
    
    // assert
    expect(result).toBe(expected);
  });
});
```

### edge cases
- empty inputs
- invalid data
- boundary values
- concurrent operations
- error conditions

## debugging tests

### verbose output
```bash
# show detailed output
bun test --verbose

# show test names only
bun test --reporter=spec
```

### debugging single test
```typescript
it.only('test to debug', () => {
  // test code
});
```

### using debugger
```bash
# run with inspector
bun test --inspect

# attach debugger
chrome://inspect
```

## known issues

### flaky tests
- none currently

### slow tests
- consensus tests with many blocks
- integration tests with docker

### removed tests
integration tests for deleted components:
- peer-discovery.test.ts
- cluster-e2e.test.ts
- network-components.test.ts
- sync-manager.test.ts
- tcp-connections.test.ts

## key improvements from testing

### bugs discovered and fixed
1. **mempool nonce ordering**: fixed transaction sorting for same-sender
2. **block template format**: corrected coinbase inclusion
3. **pending nonce tracking**: added actor-level management
4. **state validation**: added temporary state during validation
5. **timestamp handling**: fixed rapid block creation
6. **protocol deserialization**: fixed getblocks message handling

### test infrastructure
- blockchainactor class for user simulation
- miner class for concurrent mining
- enhanced logging for debugging
- deterministic transaction sorting
- improved fee and balance verification

## future improvements

- increase coverage to 90%+
- add property-based testing
- implement load testing
- add mutation testing
- create visual regression tests