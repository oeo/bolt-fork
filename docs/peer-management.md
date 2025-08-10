# peer management

## overview

the bolt peer management system maintains a healthy p2p network by scoring peers, tracking reputation, banning misbehaving nodes, and ensuring optimal peer selection for network operations.

## peer manager (src/network/peer-manager.ts)

the peer manager tracks all connected peers and their behavior:

```typescript
const peerManager = new PeerManager({
  node,
  storage,
  maxPeers: 50,              // maximum peer connections
  minPeers: 5,               // minimum peer target
  scoreDecayInterval: 60000, // score decay interval (ms)
  banDuration: 86400000,     // ban duration (24 hours)
  maxInvalidMessages: 10,    // max invalid before ban
  preferredPeers: [...]      // always-connect peers
});
```

## peer information

each peer is tracked with comprehensive metadata:

```typescript
interface PeerInfo {
  id: string;              // peer identifier
  address: string;         // multiaddr
  lastSeen: number;        // last activity timestamp
  firstSeen: number;       // first connection time
  score: number;           // reputation score (0-100)
  height: number;          // blockchain height
  difficulty: bigint;      // cumulative difficulty
  version: string;         // protocol version
  services: string[];      // offered services
  latency: number;         // response time (ms)
  bytesReceived: number;   // total bytes received
  bytesSent: number;       // total bytes sent
  messagesReceived: number;
  messagesSent: number;
  invalidMessages: number; // invalid message count
  connectionCount: number; // total connections
  banned: boolean;         // ban status
  banReason?: string;      // reason for ban
  banExpiry?: number;      // ban expiration time
}
```

## scoring system

peers are scored from 0-100 based on behavior:

### score increases
- providing valid blocks: +5
- providing valid transactions: +2
- responding to requests: +1
- long connection duration: +0.5/hour
- providing status updates: +1

### score decreases
- invalid messages: -10
- timeout on requests: -5
- protocol violations: -20
- excessive requests: -5
- connection drops: -2

### score thresholds
- **100**: preferred peer (manually configured)
- **75-99**: excellent peer
- **50-74**: good peer
- **25-49**: acceptable peer
- **1-24**: poor peer
- **0**: banned peer

## peer lifecycle

### connection
1. peer connects to node
2. added to peer list with initial score (50)
3. preferred peers start at score 100
4. connection count incremented

### monitoring
continuous tracking of:
- message validity
- response times
- data transfer metrics
- protocol compliance
- connection stability

### scoring updates
- real-time adjustments based on behavior
- periodic decay to neutral (every minute)
- bonus for long-lived connections
- penalties for violations

### disconnection
- last seen time updated
- connection remains in peer list
- score gradually decays if not reconnected
- may trigger peer replacement

### banning
triggers for banning:
- score drops to 0
- exceeds invalid message threshold
- severe protocol violation
- manual ban by operator

ban effects:
- immediate disconnection
- blocked from reconnecting
- removed from peer selection
- expires after ban duration

## peer selection

### best peer selection
for critical operations like sync:
```typescript
const bestPeers = peerManager.getBestPeers(10);
// returns top 10 peers by score
```

### active peer filtering
```typescript
const activePeers = peerManager.getActivePeers();
// returns non-banned peers only
```

### preferred peers
- never banned regardless of score
- always maintained connections
- higher initial scores
- priority in peer selection

## capacity management

### maximum peers
when at capacity:
1. new peer requests connection
2. find lowest scoring non-preferred peer
3. evict if new peer likely better
4. accept new connection

### minimum peers
when below minimum:
1. attempt reconnection to known good peers
2. query bootstrap nodes
3. accept any incoming connections
4. relaxed scoring requirements

## metrics and statistics

```typescript
interface PeerStats {
  totalPeers: number;        // all known peers
  activePeers: number;       // non-banned peers
  bannedPeers: number;       // currently banned
  averageScore: number;      // average active score
  averageLatency: number;    // average response time
  totalBytesReceived: number;
  totalBytesSent: number;
}
```

### retrieving stats
```typescript
const stats = peerManager.getStats();
```

## persistence

peer data can be persisted to storage:

### saving peers
- periodic saves during operation
- save on shutdown
- includes scores and ban status

### loading peers
- restore on startup
- validate ban expiries
- update last seen times

## event handling

the peer manager responds to node events:

### peer:connect
- add new peer or update existing
- initialize scoring
- check capacity limits

### peer:disconnect
- update last seen
- maintain in peer list
- trigger replacement if needed

### peer:status
- update blockchain height
- update difficulty
- adjust score positively

### peer:invalid
- increment invalid count
- decrease score
- potentially ban peer

### peer:message
- track bytes transferred
- update message counts
- monitor for flooding

## configuration

### capacity settings
- `maxPeers`: maximum simultaneous connections
- `minPeers`: minimum connection target
- `preferredPeers`: always-connect peer list

### scoring settings
- `scoreDecayInterval`: how often scores decay
- `maxInvalidMessages`: invalid message threshold
- `banDuration`: how long bans last

### operational settings
- `storage`: optional storage adapter
- `node`: required bolt node instance

## security features

### ban system
- automatic banning for misbehavior
- configurable ban duration
- ban reason tracking
- expiry management

### preferred peer protection
- immune to automatic banning
- maintained connections
- manual intervention only

### score decay
- prevents score manipulation
- trends toward neutral
- rewards consistency

### dos protection
- message rate tracking
- invalid message limits
- automatic disconnection
- peer replacement

## integration

### with sync service
- provides best peers for syncing
- tracks peer heights
- manages peer reliability

### with network node
- handles connection events
- manages peer lifecycle
- enforces capacity limits

### with storage
- optional persistence
- peer history tracking
- ban list management

## monitoring

available metrics:
- `peers_total` - total known peers
- `peers_active` - active connections
- `peers_banned` - banned peers
- `peer_score_average` - average score
- `peer_bytes_in` - bytes received
- `peer_bytes_out` - bytes sent
- `peer_messages_invalid` - invalid messages

## testing

peer manager testing includes:
- unit tests for scoring logic
- connection limit tests
- ban/unban functionality
- preferred peer handling
- statistics calculation
- event handling
- 15 tests, all passing