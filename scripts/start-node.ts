#!/usr/bin/env bun

import { Blockchain } from '../src/core/blockchain';
import { Mempool } from '../src/core/mempool';
import { BoltNode } from '../src/network/node';
import { ApiServer } from '../src/api/server';
import { SyncService } from '../src/services/sync';
import { PeerManager } from '../src/network/peer-manager';
import { NetworkSecurity } from '../src/network/security';
import { MempoolSync } from '../src/network/mempool-sync';
import { MiningService } from '../src/services/mining';
import { createStorage } from '../src/storage';
import { config as chainConfig } from '../src/config/chain';
import { getLogger } from '../src/utils/logger';

const logger = getLogger(__filename);

/**
 * start a bolt node with all services
 */
async function startNode() {
  logger.info('Starting bolt node...');
  
  // get configuration from environment
  const nodeRole = process.env.NODE_ROLE || 'full_node';
  const miningEnabled = process.env.MINING_ENABLED === 'true';
  const minerAddress = process.env.MINER_ADDRESS;
  const storageType = process.env.STORAGE_TYPE || 'memory';
  const p2pPort = parseInt(process.env.P2P_PORT || '7334');
  const apiPort = parseInt(process.env.API_PORT || '7333');
  const bootstrapNodes = process.env.BOOTSTRAP_NODES?.split(',') || [];
  
  logger.info(`Node configuration:`, {
    role: nodeRole,
    mining: miningEnabled,
    p2pPort,
    apiPort,
    storage: storageType,
    network: chainConfig.name
  });
  
  // create storage
  const storage = createStorage(storageType as any);
  await storage.connect();
  
  // create blockchain
  const blockchain = new Blockchain(storage, chainConfig);
  await blockchain.initialize();
  
  // create mempool
  const mempool = new Mempool(storage, chainConfig);
  await mempool.initialize();
  
  // create p2p node
  const node = new BoltNode({
    port: p2pPort,
    chainConfig,
    enableDHT: true,
    enableGossipsub: true,
    bootstrapNodes: bootstrapNodes.length > 0 ? bootstrapNodes : undefined
  });
  
  // create peer manager
  const peerManager = new PeerManager({
    node,
    storage,
    maxPeers: 50,
    minPeers: 3
  });
  
  // create network security
  const security = new NetworkSecurity({
    node,
    peerManager
  });
  
  // create sync service
  const syncService = new SyncService({
    blockchain,
    node
  });
  
  // create mempool sync
  const mempoolSync = new MempoolSync({
    mempool,
    node
  });
  
  // create api server
  const apiServer = new ApiServer({
    port: apiPort,
    blockchain,
    mempool,
    node,
    storage
  });
  
  // create mining service if enabled
  let miningService: MiningService | null = null;
  if (miningEnabled && minerAddress) {
    miningService = new MiningService({
      blockchain,
      mempool,
      minerAddress,
      autoStart: false
    });
  }
  
  // start all services
  try {
    logger.info('Starting P2P node...');
    await node.start();
    
    logger.info('Starting peer manager...');
    await peerManager.start();
    
    logger.info('Starting network security...');
    security.start();
    
    logger.info('Starting sync service...');
    await syncService.start();
    
    logger.info('Starting mempool sync...');
    mempoolSync.start();
    
    logger.info('Starting API server...');
    await apiServer.start();
    
    if (miningService) {
      logger.info('Starting mining service...');
      await miningService.start();
    }
    
    logger.info('✅ bolt node started successfully!');
    logger.info(`API available at http://localhost:${apiPort}`);
    logger.info(`P2P listening on port ${p2pPort}`);
    
    // log stats periodically
    setInterval(() => {
      const height = blockchain.getHeight();
      const peers = node.getPeers().length;
      const mempoolSize = mempool.getStats().size;
      
      logger.info('Node stats:', {
        blockHeight: height,
        peers,
        mempool: mempoolSize,
        role: nodeRole
      });
    }, 30000); // every 30 seconds
    
  } catch (error) {
    logger.error('Failed to start node:', error);
    process.exit(1);
  }
  
  // handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down node...');
    
    if (miningService) {
      await miningService.stop();
    }
    
    await apiServer.stop();
    mempoolSync.stop();
    syncService.stop();
    security.stop();
    await peerManager.stop();
    await node.stop();
    await storage.close();
    
    logger.info('Node shutdown complete');
    process.exit(0);
  });
}

// start the node
startNode().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});