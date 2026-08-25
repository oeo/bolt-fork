# networking

bolt uses a two-layer networking architecture that separates peer discovery from data exchange.

## architecture overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     node 1      │     │     node 2      │     │     node 3      │
│                 │     │                 │     │                 │
│ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │
│ │ tcp server  │◄├─────┤►│ tcp client  │◄├─────┤►│ tcp client  │ │
│ │ port 8333   │ │     │ │             │ │     │ │             │ │
│ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │
│                 │     │                 │     │                 │
│ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │
│ │    ipfs     │ │     │ │    ipfs     │ │     │ │    ipfs     │ │
│ │ (discovery) │◄├─────┤►│ (discovery) │◄├─────┤►│ (discovery) │ │
│ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## peer discovery

ipfs is used exclusively for peer discovery via pubsub:

### announcement format
```json
{
  "nodeId": "1K5t98ovEbVJv5HhYqJm1KPmgXvTYXUpQF",
  "tcp": "node1:8333",
  "height": 1250,
  "chainHash": "abc123...",
  "timestamp": 1704067200
}
```

### discovery process
1. nodes announce their tcp endpoint every 30 seconds on `/bolt/peers`
2. nodes subscribe to peer announcements
3. discovered peers are tracked with metadata
4. connection manager establishes tcp connections to discovered peers

## tcp protocol

all blockchain data exchange happens over tcp using a binary protocol.

current protocol version: `3`.

### message format
```
┌──────────┬──────────┬──────────┬──────────┬──────────────┐
│  magic   │   type   │  length  │ checksum │   payload    │
│ 4 bytes  │ 4 bytes  │ 4 bytes  │ 4 bytes  │ variable     │
└──────────┴──────────┴──────────┴──────────┴──────────────┘
```

- **magic**: network identifier (0x12699C94)
- **type**: message type enum
- **length**: payload size in bytes
- **checksum**: first 4 bytes of double-sha256
- **payload**: message-specific data

### message types

#### handshake
- `version` - capability exchange
- `verack` - version acknowledgement

#### synchronization
- `getheaders` - request header chain
- `headers` - header chain response
- `getblocks` - request block inventory
- `inv` - inventory announcement
- `getdata` - request specific items

#### data transfer
- `block` - full block data
- `tx` - chain-bound transaction data, including `chainId` and `kind`

#### maintenance
- `ping` - connection keepalive
- `pong` - ping response

## synchronization

bolt uses headers-first synchronization with parallel block downloads.

### sync process
1. **header sync**: request and validate header chain
2. **block download**: parallel fetch of blocks (max 16 concurrent)
3. **orphan handling**: store out-of-order blocks
4. **chain building**: connect blocks as parents arrive

### block locator
exponential backoff for efficient sync:
```
[tip, tip-1, tip-2, tip-4, tip-8, tip-16, ..., genesis]
```

## connection management

### limits
- maximum connections: 125 peers
- inbound connections: 100
- outbound connections: 25

### connection lifecycle
1. discovery via ipfs
2. tcp connection establishment
3. version handshake
4. continuous sync and relay
5. automatic reconnection on failure

## inventory management

tracks what each peer has:
- per-peer block inventory
- per-peer transaction inventory
- deduplication of announcements
- smart peer selection for downloads

## transaction relay

efficient transaction propagation:
- deduplication via recent cache
- relay to all connected peers
- mempool sync on connection
- orphan transaction handling

## performance

### optimizations
- binary protocol minimizes bandwidth
- parallel downloads maximize throughput
- inventory deduplication reduces redundancy
- connection pooling for efficiency
- backpressure handling prevents overload

### benchmarks
- sync speed: ~1000 blocks/minute
- message latency: <10ms local, <100ms internet
- bandwidth: <10mbps average
- memory: <100mb per connection

## security

### protocol security
- magic bytes prevent cross-network messages
- checksums detect corruption
- size limits prevent memory exhaustion
- connection limits prevent dos

### planned enhancements
- peer reputation scoring
- ban list for malicious peers
- encryption for privacy
- tor/i2p support

## configuration

### environment variables
```bash
# tcp server port
TCP_PORT=8333

# ipfs api endpoint
IPFS_API=http://localhost:5001

# connection limits
MAX_CONNECTIONS=125
MAX_INBOUND=100
MAX_OUTBOUND=25

# sync parameters
SYNC_BATCH_SIZE=10
SYNC_TIMEOUT=30000
MAX_RETRIES=3
```

## debugging

### useful commands
```bash
# check peer connections
curl http://localhost:7333/network/peers

# monitor sync status
curl http://localhost:7333/network/sync

# view network stats
curl http://localhost:7333/network/stats
```

### common issues

**sync stuck at height 0**
- check ipfs connectivity
- verify tcp port is accessible
- ensure at least one peer has blocks

**high bandwidth usage**
- reduce max connections
- increase announcement interval
- enable compression (future)

**connection drops**
- check firewall settings
- verify network stability
- review backpressure handling
