# bolt blockchain implementation plan

current focus: Phase 3 - mining service and GetBlockTemplate implementation

## Project file structure

```
bolt-ts/
├── src/
│   ├── types.ts         # all typescript interfaces and types
│   ├── constants.ts     # immutable protocol constants (BIP standards, crypto sizes)
│   ├── config/          # configuration management
│   │   ├── chain.ts     # ChainConfig interface and loader
│   │   └── chains/      # network-specific configurations
│   │       ├── mainnet.ts  # mainnet chain config
│   │       ├── testnet.ts  # testnet chain config
│   │       └── devnet.ts   # local development config
│   ├── crypto/          # cryptographic operations and address functionality
│   │   ├── address.ts   # HD key generation, address creation, key derivation
│   │   ├── hash.ts      # hashing utilities
│   │   └── signature.ts # transaction signing and verification
│   ├── core/            # blockchain core components
│   │   ├── block.ts     # block class with mining and validation
│   │   ├── blockchain.ts # main blockchain orchestration
│   │   ├── transaction.ts # transaction processing
│   │   ├── mempool.ts   # mempool management (to be implemented)
│   │   └── difficulty.ts # difficulty adjustment algorithm
│   ├── storage/         # storage layer
│   │   ├── adapter.ts   # storage adapter interface
│   │   ├── redis.ts     # redis implementation
│   │   ├── memory.ts    # in-memory implementation for testing
│   │   └── index.ts     # storage factory
│   ├── utils/           # utility functions
│   │   ├── logger.ts    # pino structured logging
│   │   └── currency.ts  # watt/BOLT conversion and formatting utilities
│   ├── services/        # background services (future)
│   │   ├── mining.ts    # mining service
│   │   ├── sync.ts      # blockchain synchronization
│   │   └── metrics.ts   # prometheus metrics collection
│   ├── network/         # p2p networking (future)
│   │   ├── node.ts      # libp2p node setup
│   │   ├── messages.ts  # network message types
│   │   ├── peer-manager.ts # peer scoring and management
│   │   ├── bootstrap.ts # bootstrap node configuration
│   │   ├── block-relay.ts # block propagation protocol
│   │   ├── tx-relay.ts    # transaction broadcasting protocol
│   │   ├── sync-protocol.ts # chain synchronization protocol
│   │   └── security.ts  # rate limiting and dos protection
│   ├── api/             # external interfaces (future)
│   │   ├── server.ts    # rest api server
│   │   ├── routes.ts    # api route handlers
│   │   └── websocket.ts # websocket server for real-time events
│   ├── config.ts        # configuration management (future)
│   └── index.ts         # main node entry point (future)
├── tests/
│   ├── unit/            # unit tests for each component
│   ├── integration/     # integration tests
│   ├── e2e/            # end-to-end multi-node tests
│   └── bats/           # deployment and system tests
├── docs/               # technical documentation
├── monitoring/         # monitoring configurations
│   ├── dashboard.json  # grafana dashboard definition
│   ├── alerts.yml      # prometheus alert rules
│   ├── prometheus.yml  # prometheus configuration
│   ├── loki.yml        # loki configuration
│   └── datasources.yml # grafana datasources
├── scripts/            # utility scripts
├── package.json        # project dependencies
├── tsconfig.json       # typescript configuration
├── Dockerfile          # docker image definition
├── docker-compose.yml  # multi-container orchestration
├── bun.lockb          # bun lock file
├── .env.example       # environment variables template
└── README.md          # project documentation
```

## Architectural decisions

### Currency denomination: watts instead of satoshis
- **Unique identity**: Using "watts" as the base unit differentiates BOLT from Bitcoin
- **Energy metaphor**: Fits with the "bolt" (lightning) theme - watts measure electrical power
- **Same precision**: Maintains 8 decimal places like Bitcoin (1 BOLT = 100,000,000 watts)
- **Memorable**: "Send me 50 million watts" or "Send me 0.5 BOLT"
- **Technical consistency**: All internal calculations and storage use watts as the base unit

### Account model with nonces (Bitcoin-inspired, Ethereum-like)
- **No UTXO model**: Unlike Bitcoin, we use an account-based model for simplicity
- **Nonces for replay protection**: Each address has a sequential nonce to prevent transaction replay
- **Balance tracking**: Direct balance storage in watts instead of calculating from UTXOs
- **Simpler implementation**: Easier to understand and implement than UTXO model
- **Trade-offs**: Less privacy than UTXO, but simpler state management

### Consolidated crypto module (address-based system)
- **Single responsibility**: All cryptographic operations in `crypto/` directory
- **HD key generation in address.ts**: Hierarchical deterministic key functionality integrated
- **No separate class**: Addresses and keys are primitives, not objects
- **Cleaner separation**: Blockchain logic separate from key management
- **Flexibility**: Applications can implement their own abstractions on top

### Nonce handling for multiple transactions
- **Sequential nonces**: Multiple transactions from same sender must have sequential nonces
- **In-block validation**: Tracks nonce progression within each block
- **Atomic updates**: All transactions in a block succeed or fail together
- **Prevents double-spend**: Combination of nonces and balance checks

### Configuration architecture
- **Chain configs**: TypeScript files in `src/config/chains/` define consensus parameters
- **Chain version hash**: Calculated from config to ensure all nodes agree on rules
- **Feature activation**: Support for enabling features at specific block heights
- **Clear separation**: Protocol constants (src/constants.ts) vs chain config vs operational settings (.env)
- **Type safety**: Using TypeScript for configs allows bigint support and compile-time checks

## Development principles

### Test-driven development
- **ALWAYS write tests immediately after implementing each feature**
- **Never move to the next feature until current tests pass**
- **Minimum test coverage: unit tests for all functions, integration tests for component interactions**
- **Run tests before committing any code**

### Monitoring and observability
- **Structured logging with pino from day one**
- **Metrics collection with prometheus for all key operations**
- **Grafana dashboards for visualization**
- **Comprehensive error tracking and alerting**

### Bun-specific advantages
- **No TypeScript compilation needed - run .ts files directly**
- **Built-in environment variable support - no dotenv required**
- **Fast native test runner**
- **Excellent performance for crypto operations**

## Phase 0: Docker environment setup ✅

- [x] create docker environment
  - [x] create Dockerfile for bolt node with bun runtime
  - [x] create docker-compose.yml with services:
    - [x] redis for storage
    - [x] prometheus for metrics
    - [x] loki for logs
    - [x] grafana for visualization
    - [x] promtail for log collection
  - [x] create .env.example with environment variables
  - [x] create monitoring/ directory with initial configs
    - [x] prometheus.yml with scrape configs
    - [x] loki.yml with storage config
    - [x] datasources.yml for grafana
    - [x] basic dashboard.json template
  - [x] test docker-compose up with all services
  - [x] verify redis connection
  - [x] verify monitoring stack accessibility

## Phase 1: Core foundation ✅

- [x] initialize project structure
  - [x] create package.json with dependencies (@noble/secp256k1, ioredis, libp2p, @chainsafe/libp2p-gossipsub, pino, prom-client)
  - [x] create tsconfig.json for typescript (IDE support only, not compilation)
  - [x] create directory structure as specified above
  - [x] setup bun test configuration in package.json scripts
  - [x] setup basic logging infrastructure (src/utils/logger.ts)
  - [x] verify docker environment with simple redis test

- [x] implement core types (src/types.ts)
  - [x] Block interface with validation fields
    - [x] include chainVersionHash field
  - [x] AccountState interface with balance and nonce (removed wallet concept)
  - [x] Transaction interface (amounts in BOLT)
  - [x] DifficultyAdjustment interface
  - [x] StorageAdapter interface (abstract storage operations)
  - [x] Network message types
    - [x] version message with chain hash
  - [x] Peer information types
  - [x] chain validation types
  - [x] write unit tests for type guards

- [x] implement cryptography layer (src/crypto/)
  - [x] hash.ts - dynamic hashing (sha256, sha512, scrypt, double-sha256)
    - [x] write tests for hash functions
  - [x] address.ts - base58 address encoding with checksum
    - [x] write tests for address generation/validation
  - [x] signature.ts - secp256k1 signing and verification
    - [x] write tests for signing/verification

- [x] implement storage adapter interface (src/storage/adapter.ts)
  - [x] define abstract StorageAdapter class with methods:
    - [x] saveBlock(block: Block): Promise<void>
    - [x] getBlock(height: number): Promise<Block | null>
    - [x] getBlockByHash(hash: string): Promise<Block | null>
    - [x] getLatestBlock(): Promise<Block | null>
    - [x] getAccountState(address: string): Promise<AccountState>
    - [x] updateAccountState(address: string, state: AccountState): Promise<void>
    - [x] getCumulativeDifficulty(): Promise<bigint>
    - [x] getTransaction(hash: string): Promise<Transaction | null>
    - [x] close(): Promise<void>
  - [x] write unit tests for interface compliance

- [x] implement redis storage adapter (src/storage/redis.ts)
  - [x] extend StorageAdapter interface
  - [x] connection management with retry logic
  - [x] define key-value schema:
    - [x] blocks:{height} -> block data
    - [x] blocks:hash:{hash} -> height mapping
    - [x] state:{address} -> {balance, nonce}
    - [x] chain:cumulative -> total difficulty
    - [x] mempool:{txhash} -> transaction
  - [x] implement all StorageAdapter methods for Redis
  - [x] atomic account balance updates (in watts)
  - [x] difficulty history storage
  - [x] write integration tests with docker redis

- [x] implement storage factory (src/storage/index.ts)
  - [x] createStorage(type: 'redis' | 'memory' | 'leveldb'): StorageAdapter
  - [x] configuration-based storage selection
  - [x] implement memory adapter for immediate testing
  - [x] lazy loading of storage implementations
  - [x] write tests for factory pattern

- [x] implement block class with validation (src/core/block.ts)
  - [x] block structure with previousHash linking
  - [x] calculateHash() method
  - [x] validatePreviousBlock() method
  - [x] proof-of-work mining with dynamic difficulty
  - [x] validateDifficulty() against target
  - [x] merkle root calculation for transactions
  - [x] block timestamp validation (not too far in future/past)
  - [x] write unit tests for all block methods

- [x] implement transaction class (src/core/transaction.ts)
  - [x] transaction structure with from, to, amount, nonce
  - [x] transaction hash calculation
  - [x] signature validation
  - [x] serialize/deserialize methods
  - [x] write unit tests for transaction validation

- [x] implement difficulty adjustment (src/core/difficulty.ts)
  - [x] calculate new difficulty every 2016 blocks
  - [x] target block time: 5 minutes (300 seconds)
  - [x] adjustment period: 2016 blocks = ~1 week
  - [x] max adjustment factor: 4x increase or 1/4 decrease
  - [x] calculate actual time vs expected time
  - [x] get average block time for period
  - [x] minimum difficulty floor
  - [x] write unit tests for adjustment calculations

- [x] implement blockchain class (src/core/blockchain.ts)
  - [x] accept StorageAdapter in constructor (dependency injection)
  - [x] genesis block creation
  - [x] BOLT currency with 8 decimal places (1 BOLT = 100,000,000 watts)
  - [x] initial block reward: 50 BOLT (5,000,000,000 watts)
  - [x] halving every 210,000 blocks
  - [x] addBlock() with full validation
  - [x] getDifficulty() for current target
  - [x] getCumulativeDifficulty() for chain weight
  - [x] getBalance() from storage adapter (in watts)
  - [x] iterateChain() to traverse entire blockchain
  - [x] calculateAllBalances() to derive account balances from chain history
  - [x] selectBestChain() based on cumulative difficulty
  - [x] write integration tests with mock storage adapter

## Phase 2: Transaction ecosystem (completed)

- [x] refactor configuration system
  - [x] create ChainConfig interface in src/config/chain.ts
  - [x] move consensus parameters to TypeScript files in src/config/chains/
  - [x] create chains/mainnet.ts with production parameters
  - [x] create chains/testnet.ts with test network parameters  
  - [x] create chains/devnet.ts with fast local development parameters
  - [x] implement config loading with calculateChainVersionHash() function
  - [x] add addressPrefix to each network config
  - [x] update .env to only contain operational settings (ports, storage, etc)
  - [x] add feature activation heights support for future upgrades
  - [x] update all code to use new config system (blockchain, mempool, tests)
  - [x] write comprehensive tests for config loading and validation
  - [x] create src/constants.ts for immutable protocol constants
  - [x] deprecate old constants.ts file

- [x] update codebase to use "watt" terminology
  - [x] add WATTS_PER_BOLT constant = 100_000_000n
  - [x] create config/constants.ts with all blockchain parameters
  - [x] create utils/currency.ts with conversion and formatting functions
  - [x] support ENV variable overrides for all economic parameters
  - [x] update README with currency information
  - [x] fix .env and .env.example to use watts values
  - [x] create comprehensive tests for currency utilities
  - [x] create tests for constants and ENV overrides

- [x] implement mempool (src/core/mempool.ts)
  - [x] add transaction to mempool with validation
  - [x] remove transaction from mempool
  - [x] get transactions for block inclusion
  - [x] transaction prioritization by fee with deterministic sorting
  - [x] mempool size limits with eviction
  - [x] transaction expiration
  - [x] duplicate transaction detection
  - [x] write tests for mempool operations

- [x] enhance crypto/address module with HD key functionality
  - [x] HD key support with mnemonic seed (BIP39)
  - [x] hierarchical deterministic key derivation (BIP32/BIP44)
  - [x] derive multiple addresses from single seed
  - [x] address generation from private key
  - [x] address validation and checksum verification
  - [x] export/import private keys (WIF format)
  - [x] deterministic address generation with paths
  - [ ] add compressed public key support (33 bytes vs 65 bytes)
  - [ ] write comprehensive tests for HD key features

- [x] enhance crypto/signature module for transaction signing
  - [x] transaction signing with private keys
  - [x] signature verification
  - [x] public key recovery from signature
  - [x] serialize/deserialize transaction data for signing
  - [x] write tests for signing operations

- [x] enhance blockchain for transactions
  - [x] process transactions in blocks
  - [x] validate account nonces (sequential per address)
  - [x] handle multiple transactions from same sender in single block
  - [x] update account balances atomically
  - [x] coinbase transaction creation
  - [x] fee distribution to miners
  - [x] write integration tests for transaction processing

## Phase 3: Mining service

- [x] implement GetBlockTemplate (GBT) protocol
  - [x] create standard block template structure
  - [x] template caching and refresh logic with Redis storage
  - [x] longpoll support for template updates
  - [x] write tests for GBT protocol

- [x] implement mining service (src/services/mining.ts)
  - [x] continuous mining loop
  - [x] get block template from blockchain
  - [x] select transactions from mempool by fee
  - [x] create coinbase transaction with reward
  - [x] mine block with proof-of-work
  - [x] submit mined block to blockchain
  - [x] mining statistics tracking
  - [x] write tests for mining operations

## Phase 4: Monitoring and metrics

- [ ] implement metrics service (src/services/metrics.ts)
  - [ ] prometheus registry setup
  - [ ] blockchain metrics (height, peers, mempool size)
  - [ ] performance metrics (block mine time, tx process time)
  - [ ] api request metrics
  - [ ] expose /metrics endpoint
  - [ ] write tests for metrics collection

- [ ] enhance logging throughout codebase
  - [ ] add structured logging to blockchain operations
  - [ ] add logging to storage operations
  - [ ] implement log levels and filtering
  - [ ] verify logs appear in loki

- [ ] finalize monitoring stack
  - [ ] create comprehensive grafana dashboard
  - [ ] setup alert rules for critical events
  - [ ] test metrics flow from app to grafana
  - [ ] document monitoring access and usage

## Phase 5: P2P networking foundation

- [ ] implement libp2p node (src/network/node.ts)
  - [ ] initialize libp2p with tcp transport
  - [ ] setup gossipsub for pub/sub messaging
  - [ ] peer discovery with bootstrap nodes
  - [ ] connection management
  - [ ] node identity with persistent peer id
  - [ ] write tests for node initialization

- [ ] implement bootstrap configuration (src/network/bootstrap.ts)
  - [ ] custom bolt bootstrap nodes for primary discovery
  - [ ] fallback to public IPFS bootstrap nodes
  - [ ] implement ipfs-compatible discovery protocol
  - [ ] health checking for bootstrap nodes
  - [ ] automatic failover to public nodes
  - [ ] write tests for bootstrap failover

- [ ] implement network messages (src/network/messages.ts)
  - [ ] version handshake with chain hash
  - [ ] chain compatibility verification
  - [ ] block announcement messages
  - [ ] transaction broadcast messages
  - [ ] block request/response
  - [ ] peer height messages
  - [ ] mempool inventory messages
  - [ ] write tests for message serialization

- [ ] implement basic protocols
  - [ ] block-relay.ts - block propagation protocol
  - [ ] tx-relay.ts - transaction broadcasting
  - [ ] basic message validation
  - [ ] write tests for protocol handlers

## Phase 6: Advanced networking

- [ ] implement blockchain sync (src/services/sync.ts)
  - [ ] detect when behind network
  - [ ] request blocks from peers
  - [ ] calculate cumulative difficulty for chains
  - [ ] select chain with highest cumulative difficulty
  - [ ] validate received blocks
  - [ ] handle chain reorganization based on difficulty
  - [ ] sync progress tracking
  - [ ] parallel block downloading
  - [ ] write tests for sync scenarios

- [ ] implement peer management (src/network/peer-manager.ts)
  - [ ] peer scoring based on reliability
  - [ ] peer reputation tracking
  - [ ] automatic peer banning for misbehavior
  - [ ] connection retry with exponential backoff
  - [ ] peer persistence in redis
  - [ ] bootstrap node health checking
  - [ ] write tests for peer scoring

- [ ] implement network security (src/network/security.ts)
  - [ ] rate limiting per peer
  - [ ] message size validation
  - [ ] connection throttling
  - [ ] dos protection mechanisms
  - [ ] malicious peer detection
  - [ ] write tests for security measures

- [ ] enhance sync protocol (src/network/sync-protocol.ts)
  - [ ] compact block relay for bandwidth efficiency
  - [ ] mempool synchronization protocol
  - [ ] transaction inventory exchange
  - [ ] duplicate prevention
  - [ ] write tests for sync protocol

## Phase 7: API and real-time features

- [ ] implement rest api (src/api/server.ts)
  - [ ] core blockchain endpoints
    - [ ] GET /blocks - list blocks
    - [ ] GET /blocks/:hash - get specific block
    - [ ] GET /transactions/:hash - get transaction
    - [ ] POST /transactions - submit transaction
    - [ ] GET /wallets/:address/balance - get balance
  - [ ] network endpoints
    - [ ] GET /peers - list connected peers
    - [ ] GET /network/status - network statistics
    - [ ] POST /peers/connect - connect to peer
  - [ ] mining endpoints
    - [ ] GET /mining/template - get block template
    - [ ] POST /mining/submit - submit mined block
  - [ ] metrics endpoint
    - [ ] GET /metrics - prometheus metrics
  - [ ] write api tests for all endpoints

- [ ] implement websocket server (src/api/websocket.ts)
  - [ ] real-time block notifications
  - [ ] transaction confirmations
  - [ ] peer connection events
  - [ ] mining status updates
  - [ ] mempool updates
  - [ ] write tests for websocket events

## Phase 8: Production readiness

- [ ] implement additional storage adapters (optional)
  - [ ] memory adapter for testing (src/storage/memory.ts)
  - [ ] leveldb adapter for production (src/storage/leveldb.ts)
  - [ ] ensure all adapters pass same test suite

## Phase 9: Final production deployment

- [ ] implement main node (src/index.ts)
  - [ ] service orchestration
  - [ ] graceful shutdown handling
  - [ ] health monitoring
  - [ ] metrics integration
  - [ ] write integration tests for full node

- [ ] implement configuration (src/config.ts)
  - [ ] environment-based configuration (using Bun's built-in env)
  - [ ] network selection (mainnet/testnet/local)
  - [ ] storage backend selection (redis/memory/leveldb)
  - [ ] configurable blockchain parameters:
    - [ ] initial difficulty (default: 10)
    - [ ] difficulty adjustment interval (default: 2016 blocks)
    - [ ] max supply (default: 21,000,000 BOLT)
    - [ ] initial block reward (default: 50 BOLT)
    - [ ] halving interval (default: 210,000 blocks)
    - [ ] target block time (default: 300 seconds)
    - [ ] minimum difficulty floor (default: 1)
  - [ ] chain version hash calculation:
    - [ ] hash all configuration parameters
    - [ ] create unique chain identifier
    - [ ] include in genesis block
    - [ ] use for network compatibility checks
  - [ ] genesis block definition (static object per network)
  - [ ] validation and defaults
  - [ ] dynamic reconfiguration support for testnets
  - [ ] write tests for config validation and version hash

- [ ] finalize docker setup
  - [ ] optimize Dockerfile for production
  - [ ] multi-node compose configuration
  - [ ] volume management for persistence
  - [ ] container health checks
  - [ ] write deployment tests

- [ ] create bats tests (tests/bats/)
  - [ ] multi-node deployment tests
  - [ ] chain synchronization tests
  - [ ] consensus validation tests
  - [ ] network partition tests
  - [ ] transaction propagation tests

- [ ] create e2e tests (tests/e2e/)
  - [ ] full node lifecycle tests
  - [ ] multi-node consensus tests
  - [ ] fork resolution tests
  - [ ] load and stress tests

## Key specifications

### BOLT currency
- 1 BOLT = 100,000,000 watts (8 decimal places)
- Base unit: **watt** (instead of satoshi)
  - 1 watt = smallest indivisible unit
  - 100,000,000 watts = 1 BOLT
  - Example: 0.00000001 BOLT = 1 watt
- initial block reward: configurable (default: 50 BOLT = 5,000,000,000 watts)
- halving schedule: configurable (default: every 210,000 blocks)
- max supply: configurable (default: 21,000,000 BOLT = 2.1 quadrillion watts)
- no pre-mine, fair launch
- all currency parameters configurable per network

### Transaction fees (bitcoin-like model)
- minimum fee: 1 watt per byte
- maximum transaction size: 100KB
- fee market: higher fees = higher priority
- fees paid to miner of block
- prevents spam and DoS attacks
- dynamic fee estimation based on mempool
- transaction replacement by fee (RBF) supported

### Difficulty adjustment
- initial difficulty: configurable (default: 10)
- adjustment period: configurable (default: every 2016 blocks)
- target block time: configurable (default: 5 minutes / 300 seconds)
- expected period time: adjustment_interval * target_block_time
- adjustment calculation:
  ```
  actual_time = last_block.timestamp - first_block.timestamp
  expected_time = adjustment_interval * target_block_time
  adjustment = actual_time / expected_time
  new_difficulty = old_difficulty * adjustment
  ```
- limits: max 4x increase, max 1/4 decrease per adjustment
- minimum difficulty: configurable (default: 1 for testnet/development)

### Block validation rules
1. previous block hash must match exactly
2. block hash must meet current difficulty target
3. timestamp constraints:
   - not more than 2 hours in future
   - greater than median of past 11 blocks
4. merkle root must match transactions
5. block height must be previous + 1
6. difficulty must match expected (adjust every 2016 blocks)

### Account model validation rules
1. **Balance tracking**: Addresses maintain balance in watts (never negative)
2. **Nonce sequencing**: 
   - First transaction from address uses nonce 0
   - Each subsequent transaction increments nonce by 1
   - Multiple transactions in same block must have sequential nonces
   - Nonce only increments when address sends (not receives)
3. **Atomic updates**: All transactions in a block are processed atomically
4. **Sufficient funds**: Sender must have balance >= amount + fee (in watts)
5. **State consistency**: 
   - Account balances derivable from full chain history
   - Stored balances must match calculated balances from chain iteration
6. **Account creation**: Accounts created implicitly on first incoming transaction
7. **Double-spend prevention**: 
   - Nonces ensure each transaction is unique
   - Sequential nonce requirement prevents replay attacks
   - Balance checks prevent overdrafts

### Network specifications
1. libp2p for p2p networking
2. gossipsub for message propagation
3. peer scoring with reputation system
4. rate limiting and dos protection
5. compact block relay for efficiency
6. automatic chain reorganization
7. bootstrap nodes:
   - primary: custom bolt bootstrap nodes
   - fallback: public ipfs bootstrap nodes (e.g., /dnsaddr/bootstrap.libp2p.io)
   - automatic failover when custom nodes unavailable
   - compatible with ipfs discovery protocol

### Genesis block configuration
- defined as static object in config.ts
- network-specific (different for mainnet/testnet/local)
- includes:
  - height: 0
  - previousHash: '0000000000000000000000000000000000000000000000000000000000000000'
  - transactions: [] (no pre-mine)
  - difficulty: configurable initial difficulty
  - timestamp: network launch time
  - nonce: 0
  - hash: calculated based on network parameters
  - chainVersionHash: hash of all configuration parameters

### Chain version hash
- sha256 hash of all configuration parameters
- ensures nodes only sync with identically configured chains
- prevents cross-chain contamination
- included in genesis block
- verified during peer handshaking
- any config change creates new incompatible chain
- acts as chain "DNA" or fingerprint

### State management
- state derived from event-sourcing all transactions
- wallet balances calculated by iterating blockchain
- state can be rebuilt at any point by replaying transactions
- redis stores current state for fast queries
- state validation between nodes via merkle proofs

### Fork resolution
- **highest cumulative difficulty rule** (most proof-of-work, not longest chain)
- cumulative difficulty = sum of all block difficulties in chain
- reorg limit: 100 blocks maximum
- when equal cumulative difficulty: first seen wins
- orphaned blocks tracked but not processed
- always sync to chain with highest total proof-of-work
- protects against low-difficulty spam attacks

### Documentation structure (docs/)
- architecture.md - overall system design
- difficulty.md - difficulty adjustment algorithm details
- currency.md - BOLT specifications and economics
- validation.md - all validation rules
- api.md - rest api documentation
- mining.md - mining process and rewards
- networking.md - p2p protocol specifications
- storage.md - redis schema and indexes
- testing.md - testing strategy and tools
- security.md - security measures and threat model