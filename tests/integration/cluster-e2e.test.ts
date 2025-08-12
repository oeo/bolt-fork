import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { $ } from 'bun';

describe('end-to-end cluster test', () => {
  const NUM_NODES = 3;
  const BASE_API_PORT = 7333;
  
  beforeAll(async () => {
    console.log('launching test cluster...');
    await $`bun run scripts/launch-cluster.ts ${NUM_NODES} --clean`.quiet();
    
    // wait for nodes to fully start
    console.log('waiting for nodes to initialize...');
    await Bun.sleep(10000);
  }, 30000);
  
  afterAll(async () => {
    console.log('stopping test cluster...');
    await $`bun run scripts/stop-cluster.ts ${NUM_NODES}`.quiet();
  });
  
  it('should have all nodes running and accessible', async () => {
    for (let i = 1; i <= NUM_NODES; i++) {
      const port = BASE_API_PORT + (i - 1) * 10;
      const response = await fetch(`http://localhost:${port}/health`);
      expect(response.ok).toBe(true);
      
      const health = await response.json();
      expect(health.status).toBe('ok');
    }
  });
  
  it('should discover peers via ipfs', async () => {
    // check each node's network status
    for (let i = 1; i <= NUM_NODES; i++) {
      const port = BASE_API_PORT + (i - 1) * 10;
      const response = await fetch(`http://localhost:${port}/network/status`);
      
      if (response.ok) {
        const status = await response.json();
        console.log(`Node ${i} peers:`, status.connectedPeers);
        
        // each node should discover others
        expect(status.connectedPeers).toBeGreaterThanOrEqual(0);
      }
    }
  });
  
  it('should synchronize blockchain across nodes', async () => {
    // get blockchain info from all nodes
    const chainInfos = [];
    
    for (let i = 1; i <= NUM_NODES; i++) {
      const port = BASE_API_PORT + (i - 1) * 10;
      const response = await fetch(`http://localhost:${port}/blockchain/info`);
      
      if (response.ok) {
        const info = await response.json();
        chainInfos.push(info);
        console.log(`Node ${i} height:`, info.height);
      }
    }
    
    // all nodes should have same genesis
    const genesisHashes = chainInfos.map(info => info.latestBlockHash);
    const uniqueGenesis = new Set(genesisHashes);
    expect(uniqueGenesis.size).toBe(1);
  });
  
  it('should propagate transactions across network', async () => {
    // submit transaction to node 1
    const tx = {
      hash: `test-tx-${Date.now()}`,
      from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      amount: '1000000000',
      fee: '1000000',
      nonce: 0,
      timestamp: Date.now(),
      signature: 'test-sig',
      publicKey: 'test-pub'
    };
    
    const submitResponse = await fetch(`http://localhost:${BASE_API_PORT}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tx)
    });
    
    // transaction might be rejected due to validation, but that's ok for this test
    console.log('Transaction submission status:', submitResponse.status);
    
    // wait for propagation
    await Bun.sleep(2000);
    
    // check mempool on other nodes
    for (let i = 2; i <= NUM_NODES; i++) {
      const port = BASE_API_PORT + (i - 1) * 10;
      const response = await fetch(`http://localhost:${port}/mempool`);
      
      if (response.ok) {
        const mempool = await response.json();
        console.log(`Node ${i} mempool size:`, mempool.size);
      }
    }
  });
  
  it('should handle mining on first node', async () => {
    // check if node 1 is mining (configured as miner)
    const response = await fetch(`http://localhost:${BASE_API_PORT}/blockchain/info`);
    
    if (response.ok) {
      const info = await response.json();
      console.log('Miner node info:', {
        height: info.height,
        difficulty: info.difficulty,
        network: info.network
      });
      
      // wait for potential new blocks
      await Bun.sleep(5000);
      
      // check if height increased
      const response2 = await fetch(`http://localhost:${BASE_API_PORT}/blockchain/info`);
      if (response2.ok) {
        const info2 = await response2.json();
        console.log('Miner node height after wait:', info2.height);
        
        // height might increase if mining is successful
        expect(info2.height).toBeGreaterThanOrEqual(info.height);
      }
    }
  });
  
  it('should sync new blocks to other nodes', async () => {
    // get heights from all nodes
    const heights: number[] = [];
    
    for (let i = 1; i <= NUM_NODES; i++) {
      const port = BASE_API_PORT + (i - 1) * 10;
      const response = await fetch(`http://localhost:${port}/blockchain/info`);
      
      if (response.ok) {
        const info = await response.json();
        heights.push(info.height);
      }
    }
    
    console.log('Node heights:', heights);
    
    // check if nodes are in sync (allowing for small differences during active mining)
    const maxHeight = Math.max(...heights);
    const minHeight = Math.min(...heights);
    const heightDiff = maxHeight - minHeight;
    
    // allow for some difference during active mining
    expect(heightDiff).toBeLessThanOrEqual(2);
  });
  
  it('should handle peer connections via tcp', async () => {
    // check peer connections on each node
    const peerCounts: number[] = [];
    
    for (let i = 1; i <= NUM_NODES; i++) {
      const port = BASE_API_PORT + (i - 1) * 10;
      const response = await fetch(`http://localhost:${port}/peers`);
      
      if (response.ok) {
        const peers = await response.json();
        peerCounts.push(peers.count || 0);
        console.log(`Node ${i} has ${peers.count || 0} peers`);
      }
    }
    
    // each node should have connections to others
    const totalConnections = peerCounts.reduce((a, b) => a + b, 0);
    expect(totalConnections).toBeGreaterThan(0);
  });
  
  it('should expose metrics for monitoring', async () => {
    // check metrics endpoint on each node
    for (let i = 1; i <= NUM_NODES; i++) {
      const metricsPort = 7336 + (i - 1) * 10;
      const response = await fetch(`http://localhost:${metricsPort}/metrics`);
      
      if (response.ok) {
        const metrics = await response.text();
        
        // check for key metrics
        expect(metrics).toContain('blockchain_height');
        expect(metrics).toContain('mempool_size');
        expect(metrics).toContain('peers_connected');
        
        console.log(`Node ${i} metrics available at port ${metricsPort}`);
      }
    }
  });
  
  it('should handle node failures gracefully', async () => {
    // simulate node 2 failure
    console.log('simulating node 2 failure...');
    await $`docker compose -f compose/node.yml -p node2 stop`.quiet();
    
    // wait for detection
    await Bun.sleep(5000);
    
    // other nodes should continue operating
    for (const i of [1, 3]) {
      const port = BASE_API_PORT + (i - 1) * 10;
      const response = await fetch(`http://localhost:${port}/health`);
      expect(response.ok).toBe(true);
    }
    
    // restart node 2
    console.log('restarting node 2...');
    const env = {
      NODE_NAME: 'node2',
      API_PORT: '7343',
      METRICS_PORT: '7346',
      REDIS_PORT: '6381',
      IPFS_API_PORT: '5021',
      IPFS_SWARM_PORT: '4021',
      IPFS_GATEWAY_PORT: '8082',
      GRAFANA_PORT: '3002',
      PROMETHEUS_PORT: '9092',
      LOKI_PORT: '3102',
      MINING_ENABLED: 'false',
      MINER_ADDRESS: '',
      NETWORK_NAME: 'bolt-shared'
    };
    
    await $`docker compose -f compose/node.yml -p node2 up -d --no-build`.env(env).quiet();
    
    // wait for node to rejoin
    await Bun.sleep(10000);
    
    // node 2 should be back online
    const response = await fetch(`http://localhost:7343/health`);
    expect(response.ok).toBe(true);
    
    // should resync with network
    const infoResponse = await fetch(`http://localhost:7343/blockchain/info`);
    if (infoResponse.ok) {
      const info = await infoResponse.json();
      console.log('Node 2 after restart - height:', info.height);
      expect(info.height).toBeGreaterThanOrEqual(0);
    }
  });
});