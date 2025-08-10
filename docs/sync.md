# blockchain synchronization

## overview

the bolt blockchain synchronization system ensures nodes stay in consensus with the network by detecting when they're behind, downloading missing blocks, and handling chain reorganizations based on proof-of-work.

## components

### sync service (src/services/sync.ts)

the main synchronization orchestrator that manages the sync process:

```typescript
const syncService = new SyncService({
  blockchain,
  node,
  syncBatchSize: 100,      // blocks per batch
  syncTimeout: 30000,       // request timeout in ms
  maxReorgDepth: 100        // maximum reorganization depth
});

await syncService.start();
```

### sync detection

the sync service continuously monitors peer heights and cumulative difficulties:

1. **peer status tracking** - maintains a map of peer heights and difficulties
2. **behind detection** - compares local height with best peer
3. **work comparison** - uses cumulative difficulty to determine best chain
4. **automatic triggering** - initiates sync when behind

### sync process

when a node detects it's behind:

1. **find best peer** - select peer with highest cumulative difficulty
2. **batch requesting** - request blocks in configurable batches
3. **validation** - validate each block before adding
4. **progress tracking** - monitor and report sync progress
5. **error handling** - handle invalid blocks and timeouts

```typescript
// sync progress tracking
const stats = syncService.getStats();
{
  isSyncing: true,
  currentHeight: 500,
  targetHeight: 1000,
  peersAhead: 3,
  syncProgress: 0.5,    // 50% complete
  lastSyncTime: 1691615999000
}
```

## chain reorganization

bolt handles chain reorganizations when a competing chain with more proof-of-work is discovered:

### reorganization detection

occurs when:
- receiving a block that doesn't connect to current chain tip
- peer announces chain with higher cumulative difficulty
- sync discovers alternative chain during download

### reorganization process

1. **find common ancestor** - binary search for last common block
2. **verify work** - ensure new chain has more cumulative difficulty
3. **depth check** - ensure reorg depth doesn't exceed maximum (default: 100)
4. **rollback** - revert to common ancestor height
5. **apply new chain** - add blocks from alternative chain
6. **state recalculation** - rebuild account states from genesis
7. **transaction recovery** - re-add valid transactions to mempool

### blockchain.reorganize method

```typescript
async reorganize(
  commonAncestorHeight: number,
  newBlocks: Block[]
): Promise<boolean>
```

**process:**
1. calculates cumulative difficulty of both chain segments
2. verifies new chain has more work
3. collects transactions from removed blocks
4. resets chain to common ancestor
5. recalculates all account states
6. applies new blocks
7. re-validates and re-adds transactions

**safety measures:**
- maximum reorg depth limit (100 blocks default)
- cumulative difficulty validation
- atomic state updates
- transaction recovery

## network messages

sync-related network messages:

### get_blocks
request blocks from a peer:
```typescript
{
  type: 'GET_BLOCKS',
  startHeight: 1000,
  endHeight: 1100
}
```

### blocks
response with requested blocks:
```typescript
{
  type: 'BLOCKS',
  blocks: [...],
  count: 100
}
```

### node_status
peer status announcement:
```typescript
{
  type: 'NODE_STATUS',
  height: 5000,
  cumulativeDifficulty: '999999999n',
  bestBlockHash: 'abc123...'
}
```

## sync scenarios

### initial sync
when a new node joins the network:
1. connects to peers
2. receives peer status messages
3. detects it's at height 0
4. syncs entire chain from genesis

### catching up
when a node has been offline:
1. reconnects to network
2. discovers peers are ahead
3. syncs missing blocks
4. resumes normal operation

### fork resolution
when conflicting blocks at same height:
1. detects fork condition
2. requests both chain segments
3. calculates cumulative difficulty
4. follows chain with most work

### deep reorganization
when alternative chain is discovered:
1. finds common ancestor
2. validates reorganization depth
3. performs state rollback
4. applies new chain
5. recovers transactions

## configuration

sync service configuration options:

```typescript
{
  syncBatchSize: 100,      // blocks per request batch
  syncTimeout: 30000,       // request timeout (ms)
  maxReorgDepth: 100,       // maximum reorg depth
  syncCheckInterval: 30000  // check sync status interval
}
```

## error handling

the sync service handles various error conditions:

- **invalid blocks** - reject and ban peer
- **timeout** - retry with different peer
- **missing blocks** - request gap fill
- **corrupt data** - validate and reject
- **peer disconnection** - continue with other peers

## performance optimization

### batch downloading
- requests blocks in configurable batches
- reduces network round trips
- parallel validation possible

### peer selection
- prioritizes peers with highest cumulative difficulty
- tracks peer response times
- avoids slow or unreliable peers

### state caching
- maintains recent state snapshots
- speeds up reorganization recovery
- reduces recalculation overhead

## monitoring

sync metrics available:

- `sync_in_progress` - boolean sync status
- `sync_current_height` - current local height
- `sync_target_height` - target sync height
- `sync_progress_ratio` - completion percentage
- `sync_peers_ahead` - number of peers ahead
- `reorg_count` - total reorganizations
- `reorg_depth` - last reorg depth

## security considerations

- **maximum reorg depth** - prevents deep chain attacks
- **cumulative difficulty** - follows most work, not longest
- **peer validation** - verifies block data integrity
- **dos protection** - limits sync requests per peer
- **banned peer list** - excludes malicious peers

## testing

sync functionality is tested through:

- unit tests for sync detection logic
- integration tests for block downloading
- reorganization scenario tests
- multi-node sync simulations
- network partition tests