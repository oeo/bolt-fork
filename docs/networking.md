# bolt networking architecture

## overview

bolt uses a simplified two-layer networking architecture that separates peer discovery from data exchange:

1. **IPFS Layer**: Used exclusively for peer discovery and endpoint announcements
2. **HTTP Layer**: Handles all blockchain data exchange (blocks, transactions, sync)

this design provides reliable peer-to-peer communication with simple debugging and fast synchronization.

## network stack

```
┌─────────────────────────────────┐
│     Application Layer           │
│  (Blockchain, Mempool, Mining)  │
└─────────────────────────────────┘
         ▲              ▲
         │              │
┌────────▼──────┬───────▼─────────┐
│  HTTP Peer    │   REST API      │
│  Communication│   (Public)      │
└───────────────┴─────────────────┘
         ▲              ▲
         │              │
┌────────▼──────────────▼─────────┐
│         HTTP Layer              │
│  - Standard HTTP/JSON           │
│  - Direct peer connections      │
│  - Block sync endpoints         │
│  - Transaction propagation      │
└─────────────────────────────────┘
         ▲
         │
┌────────▼─────────────────────────┐
│      IPFS Discovery Layer       │
│  - Peer endpoint announcements  │
│  - Bootstrap node connections   │
│  - Node capability advertising  │
└─────────────────────────────────┘
```

## components

### IPFSService (src/network/ipfs.ts)

simplified IPFS client used exclusively for peer discovery:

```typescript
const ipfsService = new IPFSService({
  apiUrl: 'http://localhost:5001',
  nodeId: 'node-1',
  httpUrl: 'http://node-1:7333'
});

await ipfsService.start();
await ipfsService.announcePeer();
```

**features:**
- publishes peer endpoint announcements via IPFS pubsub
- subscribes to peer discovery topics
- handles node capability advertisement
- connects to public IPFS bootstrap nodes
- no blockchain data transmission

**discovery protocol:**
nodes announce their endpoints using this structure:
```json
{
  "nodeId": "node-1",
  "httpUrl": "http://node-1:7333",
  "capabilities": ["mining", "full_node"],
  "chainHash": "abc123...",
  "blockHeight": 1250,
  "timestamp": 1704067200
}
```

### PeerManager (src/network/peer-manager.ts)

manages HTTP connections to discovered peers:

```typescript
const peerManager = new PeerManager({
  ownNodeId: 'node-1',
  ownHttpUrl: 'http://localhost:7333'
});

// add discovered peer
peerManager.addPeer({
  nodeId: 'node-2', 
  httpUrl: 'http://node-2:7333',
  capabilities: ['mining'],
  lastSeen: Date.now()
});

// sync blocks from peers
const blocks = await peerManager.requestBlocks(startHeight);
```

### HTTP endpoints for peer communication

all blockchain data flows over standard HTTP endpoints:

**peer discovery:**
- published via IPFS pubsub, no HTTP endpoints needed

**blockchain data exchange:**
- `GET /peer/status` - node status and chain info
- `GET /peer/blocks?height=X` - get blocks from specified height
- `POST /peer/blocks` - receive new blocks from peers
- `GET /peer/transactions` - get mempool transactions  
- `POST /peer/transactions` - receive new transactions

**message format:**
all messages use JSON with bigint serialization:
```json
{
  "type": "block",
  "data": {
    "index": 123,
    "hash": "abc123...",
    "transactions": [...],
    "difficulty": "1000000"  // bigint as string
  },
  "timestamp": 1704067200
}
```

### IPFS bootstrap configuration

uses public IPFS nodes for peer discovery:

```typescript
const bootstrapNodes = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  // additional public IPFS bootstrap nodes...
];
```

**features:**
- connects to established IPFS network
- automatic peer discovery through IPFS DHT  
- no custom bootstrap nodes needed
- leverages existing IPFS infrastructure
- fallback to multiple public nodes for reliability

## peer discovery

bolt uses IPFS for peer discovery:

1. **IPFS pubsub** - nodes announce their HTTP endpoints
2. **public bootstrap nodes** - connect to established IPFS network
3. **automatic discovery** - find peers through IPFS DHT
4. **manual peering** - explicit peer connections via api (future)

### discovery flow

1. node starts IPFS client and connects to bootstrap nodes
2. node subscribes to bolt peer discovery topics
3. node announces its HTTP endpoint and capabilities
4. node discovers other peers' HTTP endpoints
5. node establishes direct HTTP connections for data exchange

## data exchange

blockchain data flows over HTTP between discovered peers:

```typescript
// broadcast a new block to all peers
const peers = peerManager.getActivePeers();
for (const peer of peers) {
  await httpClient.post(`${peer.httpUrl}/peer/blocks`, block);
}

// request missing blocks from best peer
const bestPeer = peerManager.getBestPeer();
const blocks = await httpClient.get(
  `${bestPeer.httpUrl}/peer/blocks?height=${startHeight}`
);

// handle incoming peer requests
app.post('/peer/blocks', async (req, res) => {
  const block = req.body;
  await blockchain.addBlock(block);
  res.json({ success: true });
});
```

## api integration

the rest api provides both public and peer endpoints:

**public endpoints:**
- `GET /network/status` - node and network statistics
- `GET /peers` - list discovered peers
- `GET /blockchain/info` - blockchain status

**peer endpoints (for inter-node communication):**
- `GET /peer/status` - node status for peer validation
- `GET /peer/blocks?height=X` - block synchronization
- `POST /peer/blocks` - receive blocks from peers
- `GET /peer/transactions` - mempool synchronization
- `POST /peer/transactions` - receive transactions

## configuration

network settings via environment variables:

```bash
API_PORT=7333              # HTTP API server port
IPFS_API_URL=http://localhost:5001  # IPFS API endpoint
NODE_ID=node-1             # unique node identifier
NODE_HOST=localhost        # node hostname for announcements
BOLT_NETWORK=testnet       # network selection
ENABLE_IPFS=true          # enable IPFS peer discovery
```

## security considerations

- **chain version hash** - prevents cross-chain connections
- **HTTP validation** - request size and rate limits
- **peer verification** - validate announced endpoints
- **timestamp validation** - reject stale announcements
- **endpoint filtering** - block malicious peer announcements

## testing

**multi-node testing**:
- separate docker-compose files for each node
- individual Redis and IPFS instances per node
- `scripts/test-multinode.sh` - orchestrates 3-node setup
- validates IPFS peer discovery and HTTP data exchange

**test infrastructure**:
- `docker/node1/docker-compose.yml` - miner node setup
- `docker/node2/docker-compose.yml` - second miner setup  
- `docker/node3/docker-compose.yml` - full node setup

**validation tests**:
- IPFS peer announcement functionality
- HTTP endpoint connectivity
- block propagation between nodes
- transaction synchronization
- blockchain consistency across nodes

## implementation status

**completed:**
- IPFS peer discovery working
- nodes successfully announce and discover each other
- multi-node docker testing infrastructure operational
- separation of discovery and data layers
- mining service producing valid blocks
- BigInt-safe Redis serialization
- HTTP endpoints for peer communication
- peer manager implementation for HTTP connections
- blockchain synchronization over HTTP
- automatic sync service
- block broadcasting between peers

**known issues:**
- nodes create competing forks when mining simultaneously
- blocks from other chains rejected as "invalid previous hash"
- no cumulative difficulty comparison between chains
- missing chain reorganization mechanism

**next steps:**
- implement cumulative proof-of-work consensus
- add chain reorganization based on cumulative difficulty
- ensure fork convergence within 2-3 blocks

**future enhancements:**
- peer reputation and scoring system
- rate limiting and dos protection
- optimized block relay protocols
- websocket support for real-time updates