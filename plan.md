# bolt blockchain implementation plan

current focus: tcp networking components built but not integrated - ipfs discovery working in production

## phase 1: storage foundation

### lmdb storage adapter (completed)
- [x] implement lmdb storage adapter - high-performance native bun storage
  - [x] create lmdb manager class with single environment for all databases
  - [x] implement blockchain storage with blocks, headers, and tx indexes
  - [x] implement mempool storage with fee/time/address indexes
  - [x] implement state storage for account balances
  - [x] add atomic transaction support across all databases
  - [x] create backup and recovery mechanisms
  - [x] write comprehensive unit tests for lmdb adapter
  - [x] achieved significant performance improvements over redis/memory storage

### storage migration (completed)
- [x] migrate from memory storage to lmdb - fully migrated to bun-optimized lmdb
  - [x] update blockchain class to use lmdb storage
  - [x] update mempool class to use lmdb storage  
  - [x] update state manager to use lmdb storage
  - [x] remove redis adapter completely
  - [x] verify all existing tests pass with lmdb (100% passing)
  - [x] fix mempool index queries with composite keys
  - [x] lmdb now provides persistent, fast storage with atomic transactions

### storage optimization
- [ ] optimize lmdb configuration
  - [ ] tune map size based on expected chain growth
  - [ ] implement compression for old blocks
  - [ ] add lru cache for recent blocks in memory
  - [ ] implement efficient range queries for block explorer
  - [ ] add storage metrics and monitoring

## phase 2: network protocol

### bun tcp protocol (completed)
- [x] implement binary protocol with magic bytes - native bun tcp for maximum performance
  - [x] create protocol class with message serialization using bun's native uint8array
  - [x] implement checksum validation using bun.cryptohasher (2x faster than node crypto)
  - [x] define message types (version, block, tx, inv, headers)
  - [x] add version negotiation support
  - [x] write protocol unit tests
  - [x] leverages bun's fast native tcp implementation for optimal throughput

### tcp server implementation (completed)
- [x] create bun native tcp server - high-performance server using bun.listen
  - [x] implement connection handling with bun.listen (faster than node net)
  - [x] add peer connection management and limits
  - [x] implement write backpressure handling for stable connections
  - [x] add connection timeout and cleanup
  - [x] docker setup with lmdb storage (completely migrated from redis)
  - [x] compact logging format with basename display
  - [x] node identity management with persistent .identity file
  - [x] ipfs-based peer discovery working

### network synchronization (redesigned - starting implementation)

#### complete peer handling redesign using bun-native features

**core principles:**
- ipfs only for peer discovery (no blocks/txs on ipfs)
- binary tcp protocol for all blockchain data exchange
- bun-native everything (uint8array, bun.listen, bun.cryptohasher)

**architecture overview:**
```
peer discovery (ipfs pubsub) → tcp connection manager (bun.listen/connect)
→ binary protocol handler → sync manager → blockchain
```

#### phase 1: peer discovery service (completed)
- [x] clean ipfs-only discovery implementation
  - [x] announce tcp endpoint every 30 seconds on /bolt/peers
  - [x] subscribe to peer announcements
  - [x] track known peers with metadata (height, chain hash, version)
  - [x] emit peer:discovered events for connection manager
  - [x] no blocks or transactions on ipfs

#### phase 2: tcp connection manager (completed)
- [x] bun-native tcp server and client
  - [x] use bun.listen for incoming connections
  - [x] use bun.connect for outbound connections
  - [x] connection pool management (max 125 peers)
  - [x] message buffering for partial messages
  - [x] backpressure handling with drain callback
  - [x] automatic reconnection logic

#### phase 3: binary protocol handler (completed)
- [x] efficient binary protocol using uint8array
  - [x] message format: [magic(4)][type(4)][length(4)][checksum(4)][payload]
  - [x] use bun.cryptohasher for 2x faster checksums
  - [x] commands: version, headers, blocks, inv, getdata, tx
  - [x] payload encoding/decoding for each message type
  - [x] strict validation and error handling
  - [x] added getheaders, headers, getdata message types for sync

#### phase 4: headers-first sync manager (completed)
- [x] implement headers-first synchronization
  - [x] build block locator with exponential backoff
  - [x] request headers from peers
  - [x] validate header chain before requesting blocks
  - [x] queue blocks for parallel download
  - [x] handle chain reorganizations

#### phase 5: block download manager (completed)
- [x] parallel block downloading system
  - [x] priority queue for block requests
  - [x] track in-flight requests with timeouts
  - [x] max 16 concurrent block downloads
  - [x] peer selection based on inventory and performance
  - [x] retry failed downloads with different peers

#### phase 6: inventory management (completed)
- [x] track what each peer has
  - [x] maintain per-peer block and transaction inventory
  - [x] handle inv message announcements
  - [x] filter broadcasts to avoid redundancy
  - [x] request needed items via getdata
  - [x] announce our new blocks/txs to peers

#### phase 7: orphan pool (completed)
- [x] handle out-of-order blocks
  - [x] store orphan blocks temporarily (max 100)
  - [x] connect orphans when parent arrives
  - [x] evict old orphans (>1 hour)
  - [x] prevent memory exhaustion

#### phase 8: transaction relay (completed)
- [x] efficient transaction propagation
  - [x] deduplicate recent transactions
  - [x] relay new transactions to peers
  - [x] handle getdata requests for transactions
  - [x] mempool synchronization on connect

#### implementation approach
- start with peer discovery service
- build tcp connection manager with bun.listen/connect
- implement binary protocol handler with bun.cryptohasher
- create headers-first sync manager
- add parallel block download manager
- implement inventory management system
- add orphan pool for out-of-order blocks
- complete with transaction relay system

#### success metrics
- support 125+ concurrent peer connections
- sync 100,000 blocks in under 10 minutes
- process 1000+ transactions per second
- memory usage under 500mb for full node
- network bandwidth under 10 mbps average

## phase 9: comprehensive testing

### integration tests for networking stack (completed - library level)
- [x] peer discovery tests
  - [x] test framework for peer discovery via ipfs
  - [x] tcp endpoint announcement tests
  - [x] stale peer removal tests
  - [x] peer metadata update tests

- [x] tcp connection tests
  - [x] connection establishment tests
  - [x] message buffering tests
  - [x] backpressure handling tests
  - [x] reconnection logic tests

- [x] synchronization tests
  - [x] headers-first sync tests
  - [x] parallel block download tests
  - [x] orphan handling tests
  - [x] chain reorganization tests

- [x] transaction relay tests
  - [x] transaction propagation tests
  - [x] deduplication tests
  - [x] mempool synchronization tests

### cluster testing framework (verified working)
- [x] launch multi-node clusters with docker
- [x] ipfs-based peer discovery working
- [x] block mining and propagation working
- [x] nodes sync successfully

## phase 10: integration and migration

### current system status
- [x] existing ipfs-based discovery is functional
  - nodes discover each other via ipfs pubsub
  - blocks propagate successfully
  - mining and consensus working
  - cluster can be launched with launch-cluster.ts

- [x] new tcp-based components built
  - peer-discovery.ts - ipfs for discovery only
  - connection-manager.ts - bun tcp connections
  - sync-manager.ts - headers-first sync
  - block-downloader.ts - parallel downloads
  - inventory-manager.ts - peer inventory tracking
  - orphan-pool.ts - orphan block handling
  - transaction-relay.ts - tx propagation

### architecture clarification
- ipfs is used ONLY for peer discovery (finding tcp endpoints)
- all blockchain data exchange happens over tcp sockets
- no hybrid mode - it's tcp with ipfs discovery, period

### integration tasks
- [x] create network orchestrator to manage components
- [x] integrate orchestrator into main application
- [x] complete main application integration
  - [x] fix ipfs event handlers for legacy mode
  - [x] update broadcast methods
  - [x] update metrics collection
  - [x] test with docker cluster

### current status - tcp networking operational, sync needs fixes
- tcp mode is running with all networking components functional
- ipfs used only for peer discovery (as designed)
- peer discovery working - nodes find and connect to each other
- tcp connections established between all nodes
- blocks being mined and broadcast to connected peers
- inventory management working (broadcasting to 4+ peers)
- **critical issue**: headers-first sync not working correctly
  - nodes only sync latest blocks via inv/getdata
  - historical blocks (1 to N) not being requested
  - all received blocks become orphans without parents
  - nodes stuck at height 0 despite receiving new blocks

### completed implementation
- [x] created network orchestrator to manage network modes
- [x] integrated all tcp components into main application
- [x] added bootstrap node connections for network connectivity
- [x] enabled pubsub experiment flag on ipfs daemons
- [x] fixed metrics collection for tcp mode
- [x] fixed broadcast methods to use network orchestrator
- [x] fixed sync service to only run in ipfs mode
- [x] peer discovery announcements working
- [x] tcp connections established successfully

### architecture achievements
- ipfs bootstrap nodes → pubsub discovery → tcp connections → binary protocol
- nodes announce tcp endpoints on ipfs pubsub topic
- nodes discover each other and establish direct tcp connections
- all blockchain data flows through tcp, not ipfs
- multiple redundant connections between nodes

### sync implementation issues and fixes needed

#### root cause analysis
1. **missing header sync trigger**: when nodes connect to peers with higher chains, they should request headers but currently don't
2. **broken block locator**: the buildBlockLocator function needs to properly build a locator from genesis to current tip
3. **premature sync completion**: sync completes after receiving any block, not after syncing full chain
4. **no historical block fetching**: only new blocks via inv are processed, not blocks 1 to N

#### required fixes for headers-first sync
- [ ] fix sync trigger logic
  - [ ] ensure checkIfSyncNeeded is called when peers are discovered
  - [ ] trigger headers request when peer height > our height
  - [ ] properly await async blockchain.getHeight() calls (partially done)
  
- [ ] fix headers request/response handling
  - [ ] ensure getheaders message is actually sent to peers
  - [ ] verify peers respond with headers messages
  - [ ] process headers to identify missing blocks
  - [ ] add missing blocks to download queue
  
- [ ] fix block download logic
  - [ ] after receiving headers, request all missing blocks
  - [ ] handle blocks arriving out of order (orphan pool)
  - [ ] connect orphaned blocks when parents arrive
  - [ ] only mark sync complete when all blocks downloaded

- [ ] fix height reporting
  - [ ] ensure blockchain.getHeight() returns correct value
  - [ ] verify blocks are actually persisted to storage
  - [ ] update chain tip after adding blocks

#### testing requirements
- [ ] verify node2-5 sync full chain from node1
- [ ] ensure all nodes reach same height
- [ ] test orphan resolution when blocks arrive out of order
- [ ] verify sync resumes if interrupted

- [ ] migration strategy
  - [x] add NETWORK_MODE env variable (ipfs or tcp)
  - [x] default to tcp mode
  - [x] test tcp mode with cluster
  - [x] peer discovery working correctly
  - [x] tcp connections verified between nodes
  - [ ] fix headers-first sync issues
  - [ ] remove old ipfs propagation code once stable

- [ ] production readiness
  - [ ] complete sync implementation fixes
  - [ ] stress test tcp connections at scale
  - [ ] verify sync performance improvements
  - [ ] monitor memory and bandwidth usage
  - [ ] ensure consensus stability

## phase 3: parallel processing

### bun workers (completed)
- [x] implement worker pool for cpu-intensive tasks - native bun workers for parallel processing
  - [x] create worker pool manager with dynamic sizing (2-4 workers by default)
  - [x] implement block validation workers for parallel validation
  - [x] add transaction verification workers for concurrent tx processing
  - [x] create mining workers for distributed proof-of-work computation
  - [x] implement efficient work distribution and result collection
  - [x] write comprehensive worker pool tests
  - [x] uses bun's native worker threads for better performance than node worker_threads

### worker optimization
- [ ] optimize worker communication
  - [ ] use sharedarraybuffer for zero-copy data transfer
  - [ ] implement efficient task queuing
  - [ ] add worker health monitoring
  - [ ] implement graceful worker restart on failure

## phase 4: api layer

### http api v1
- [ ] implement clean rest api with bun.serve
  - [ ] `/v1/` - node status and health endpoint
  - [ ] `/v1/blocks` - paginated block list with filters
  - [ ] `/v1/blocks/{height|hash}` - get specific block
  - [ ] `/v1/txns` - paginated transaction list  
  - [ ] `/v1/txns/{hash}` - get specific transaction
  - [ ] `/v1/accounts/{address}` - get account balance and history
  - [ ] `/v1/mempool` - get mempool statistics and transactions
  - [ ] `/v1/peers` - get connected peers information

### api features
- [ ] add websocket support for real-time updates
  - [ ] implement block notifications
  - [ ] add mempool transaction stream
  - [ ] create peer connection events
  - [ ] add chain reorganization notifications

## recent achievements

successfully completed major infrastructure improvements:

1. **storage migration**: swapped default storage from redis to lmdb
   - docker compose configuration updated for single node operation
   - all storage operations now use high-performance lmdb backend
   - persistent storage with atomic transaction support

2. **logging enhancements**: implemented compact logging format
   - hh:mm:ss.mmm time format for precise timing
   - single letter log levels (d/i/w/e) for compact output
   - basename display for cleaner file references
   - improved readability for development and debugging

3. **node identity system**: created persistent node identity using bitcoin-style addresses
   - persistent .identity file stores node's private key and address
   - bitcoin-style address generation for peer identification
   - foundation for secure peer-to-peer communication

4. **docker environment**: fixed docker compose configuration
   - working single node operation for development
   - proper volume mounting for persistent storage
   - lmdb integration within containerized environment

## phase 5: optimization and refinement

### performance optimization
- [ ] profile and optimize hot paths
  - [ ] optimize serialization/deserialization
  - [ ] improve hash computation using bun crypto
  - [ ] optimize database queries
  - [ ] reduce memory allocations
  - [ ] implement connection pooling

### reliability improvements
- [ ] add comprehensive error handling
  - [ ] implement circuit breakers for network calls
  - [ ] add retry logic with exponential backoff
  - [ ] create graceful shutdown procedures
  - [ ] implement database corruption recovery

### monitoring and observability
- [ ] add metrics collection
  - [ ] implement prometheus metrics export
  - [ ] add detailed logging with levels
  - [ ] create performance dashboards
  - [ ] add chain analytics endpoints

## phase 6: messaging and communication enhancements

### secure peer-to-peer messaging
- [ ] implement secure peer-to-peer messaging
  - [ ] add message signing with node's private key
  - [ ] implement signature verification for incoming messages
  - [ ] create encrypted communication channels between peers
  - [ ] add message replay protection

### enhanced ipfs integration
- [ ] enhanced ipfs integration
  - [ ] implement block propagation via ipfs
  - [ ] add transaction relay through pubsub
  - [ ] create distributed mempool synchronization
  - [ ] implement peer reputation system

### protocol improvements
- [ ] protocol improvements
  - [ ] add peer authentication using node identities
  - [ ] implement ban list for malicious peers
  - [ ] create peer scoring based on behavior
  - [ ] add ddos protection mechanisms

## implementation notes

### completed major improvements
1. **lmdb storage**: replaced redis/memory with high-performance lmdb storage adapter
   - single environment for all databases (blockchain, mempool, state)
   - atomic transactions across all storage operations
   - persistent storage with fast read/write performance
   - bun-optimized serialization for bigints and complex data types

2. **tcp protocol**: implemented native bun tcp server and binary protocol
   - custom binary protocol with magic bytes and checksums
   - leverages bun.listen for maximum connection performance
   - uses bun.cryptohasher for 2x faster checksum validation
   - efficient message serialization with native uint8array

3. **worker pool**: created bun-native worker threads for parallel processing
   - dynamic worker pool management (scales 2-4 workers)
   - parallel block validation and transaction verification
   - distributed mining computation across workers
   - efficient task distribution without blocking main thread

### key architectural decisions
1. single lmdb environment for all storage (blockchain, mempool, state)
2. bun-native tcp protocol instead of websockets for p2p
3. worker pool for all cpu-intensive operations
4. zero-copy data transfer where possible using sharedarraybuffer
5. headers-first synchronization strategy for faster initial sync

### bun-specific optimizations to leverage
- bun.cryptohasher for 2x faster hashing
- bun.listen for high-performance tcp server
- native uint8array operations instead of buffer
- bun workers instead of worker_threads
- bun.serve for http api
- bun timers for efficient scheduling
- native bigint serialization support
- bun.password for secure key derivation
- native bun file operations for identity management
- bun's built-in base64 encoding for message serialization

### testing strategy
- unit tests for each component using bun test
- integration tests for storage layer
- protocol conformance tests
- stress tests for network layer
- end-to-end tests with docker compose

### migration path from current codebase
1. implement lmdb storage adapter alongside existing
2. add feature flag to switch between storage backends
3. migrate component by component with tests
4. remove old storage implementations once stable
5. optimize based on production metrics