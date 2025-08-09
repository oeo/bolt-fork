# P2P networking

## Overview

Bolt uses libp2p for peer-to-peer networking, enabling nodes to discover each other, share transactions, and synchronize blocks without central coordination.

## Architecture

### Network stack
```
Application Layer
    ↓
Services (p2p.coffee)
    ↓
PeerNode (libp2p wrapper)
    ↓
libp2p protocols:
- gossipsub (message propagation)
- kad-dht (peer discovery)
- identify (peer identification)
- ping (connection health)
```

### Topics

The network uses gossipsub topics for different message types:

- `bolt-blocks` - Block announcements and propagation
- `bolt-transactions` - Transaction broadcasting
- `bolt-mempool` - Mempool synchronization
- `bolt-peers` - Peer discovery and node info

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `P2P_PORT` | `4001` | P2P listening port |
| `BOOTSTRAP_NODES` | (libp2p defaults) | Comma-separated bootstrap nodes |
| `IS_BOOTSTRAP` | `false` | Run as bootstrap node |

### Bootstrap nodes

#### Default (public libp2p)
```
/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN
/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb
```

#### Custom (for private networks)
```bash
export BOOTSTRAP_NODES="/ip4/10.0.0.1/tcp/4001,/ip4/10.0.0.2/tcp/4001"
```

#### Docker network
Nodes automatically use `node1` as bootstrap:
```
BOOTSTRAP_NODES=/ip4/node1/tcp/4001
```

## Testing p2p connectivity

### Single node test
```bash
# start node with p2p
NODE_ID=test-node npx coffee src/app.coffee

# check network status
curl http://localhost:9442/api/network/status
```

### Multi-node local test
```bash
# terminal 1 - bootstrap node
NODE_ID=node1 P2P_PORT=4001 HTTP_PORT=9442 \
  IS_BOOTSTRAP=true npx coffee src/app.coffee

# terminal 2 - peer node
NODE_ID=node2 P2P_PORT=4002 HTTP_PORT=9452 \
  BOOTSTRAP_NODES="/ip4/127.0.0.1/tcp/4001" \
  npx coffee src/app.coffee

# terminal 3 - another peer
NODE_ID=node3 P2P_PORT=4003 HTTP_PORT=9462 \
  BOOTSTRAP_NODES="/ip4/127.0.0.1/tcp/4001" \
  npx coffee src/app.coffee
```

### Docker multi-node test
```bash
# build and start network
docker-compose build
docker-compose up -d

# check each node
curl http://localhost:9442/api/network/info  # node1
curl http://localhost:9452/api/network/info  # node2
curl http://localhost:9462/api/network/info  # node3

# check connectivity
docker exec bolt-node1 curl -s localhost:9442/api/network/peers

# monitor logs
docker-compose logs -f --tail=50
```

### Network status check script
```bash
# run the network checker
npx coffee src/scripts/check-network.coffee

# check specific node
npx coffee src/scripts/check-network.coffee 9442
```

## API endpoints

### GET /api/network/status
Returns network statistics including peer count, messages sent/received.

### GET /api/network/peers
Lists all connected peer IDs.

### GET /api/network/info
Comprehensive node information including blockchain height, mempool stats, and network status.

### POST /api/network/broadcast-transaction
Manually broadcast a transaction to the network.
```bash
curl -X POST http://localhost:9442/api/network/broadcast-transaction \
  -H "Content-Type: application/json" \
  -d '{"hash": "transaction_hash"}'
```

### POST /api/network/broadcast-block
Manually broadcast a block to the network.
```bash
curl -X POST http://localhost:9442/api/network/broadcast-block \
  -H "Content-Type: application/json" \
  -d '{"height": 42}'
```

## Message flow

### Transaction propagation
1. User submits transaction via HTTP API
2. Transaction validated and added to mempool
3. Transaction broadcast to `bolt-transactions` topic
4. Peers receive and validate transaction
5. Peers add to their mempool if valid

### Block propagation
1. Miner solves block
2. Block saved to database
3. Block broadcast to `bolt-blocks` topic
4. Peers receive and validate block
5. Peers update their blockchain if valid

### Peer discovery
1. Node connects to bootstrap nodes
2. Participates in kad-dht for peer discovery
3. Exchanges peer information via identify protocol
4. Maintains peer connections with ping protocol

## Troubleshooting

### No peers connecting
```bash
# check if p2p started
curl http://localhost:9442/api/network/status | jq .response.network.isConnected

# check bootstrap nodes
echo $BOOTSTRAP_NODES

# check firewall
sudo ufw status | grep 4001

# check docker network
docker network ls
docker network inspect bolt_bolt-network
```

### High message volume
```bash
# check message stats
curl http://localhost:9442/api/network/status | jq .response.network

# monitor specific node
watch -n 1 'curl -s localhost:9442/api/network/status | jq .response.network'
```

### Peer connection issues
```bash
# test direct connectivity
telnet node1 4001

# check node logs
docker logs bolt-node1 | grep -i peer

# restart p2p service
docker-compose restart node1
```

## Performance tuning

### Connection limits
```coffee
# in peernode/index.coffee
connectionManager:
  maxConnections: 100
  minConnections: 5
```

### Topic subscriptions
Limit topics to reduce bandwidth:
```coffee
# only subscribe to needed topics
topics.blocks = @node.pubsub('bolt-blocks')
# topics.debug = @node.pubsub('bolt-debug')  # disabled
```

### Message size limits
```coffee
# in services/p2p.coffee
MAX_MESSAGE_SIZE = 1024 * 1024  # 1MB
```

## Security considerations

1. **Bootstrap node trust**: Only use trusted bootstrap nodes
2. **Message validation**: Always validate incoming messages
3. **Rate limiting**: Implement per-peer rate limits
4. **Peer scoring**: Track and ban misbehaving peers
5. **Encryption**: All connections use noise protocol

## Next steps

- [ ] Implement blockchain synchronization protocol
- [ ] Add mempool reconciliation between peers
- [ ] Implement peer scoring and reputation
- [ ] Add bandwidth monitoring
- [ ] Create network visualization dashboard