# bolt blockchain implementation plan

current focus: persistent node identity and enhanced logging implemented - ready for messaging protocol improvements

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

### network synchronization
- [ ] implement chain synchronization
  - [ ] create headers-first sync strategy
  - [ ] implement block download and validation queue
  - [ ] add orphan block handling
  - [ ] implement transaction relay
  - [ ] add inventory management system

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