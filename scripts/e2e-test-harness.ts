#!/usr/bin/env bun

import { spawn, ChildProcess } from 'child_process';
import { Blockchain } from '../src/core/blockchain';
import { Mempool } from '../src/core/mempool';
import { BoltNode } from '../src/network/node';
import { SyncService } from '../src/services/sync';
import { MempoolSync } from '../src/network/mempool-sync';
import { ApiServer } from '../src/api/server';
import { MiningService } from '../src/services/mining';
import { createStorage } from '../src/storage';
import { config as chainConfig } from '../src/config/chain';
import { generateAddress } from '../src/crypto/address';
import { getLogger } from '../src/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const logger = getLogger(__filename);

export interface NodeConfig {
  id: string;
  port: number;
  apiPort: number;
  metricsPort: number;
  role: 'bootstrap' | 'miner' | 'full';
  dataDir?: string;
  bootstrapPeers?: string[];
}

export interface NodeInstance {
  config: NodeConfig;
  process?: ChildProcess;
  blockchain?: Blockchain;
  mempool?: Mempool;
  node?: BoltNode;
  sync?: SyncService;
  mempoolSync?: MempoolSync;
  api?: ApiServer;
  miner?: MiningService;
  storage?: any;
  running: boolean;
}

export class E2ETestHarness {
  private nodes: Map<string, NodeInstance> = new Map();
  private baseDir: string;
  
  constructor(baseDir: string = '/tmp/bolt-e2e-test') {
    this.baseDir = baseDir;
    this.ensureDirectory(baseDir);
  }
  
  private ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  
  async spawnNode(config: NodeConfig): Promise<NodeInstance> {
    logger.info(`Spawning node ${config.id} with role ${config.role}`);
    
    const instance: NodeInstance = {
      config,
      running: false
    };
    
    // create data directory
    const dataDir = config.dataDir || path.join(this.baseDir, config.id);
    this.ensureDirectory(dataDir);
    
    // create storage
    const storage = createStorage({
      type: 'redis',
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      keyPrefix: `bolt:e2e:${config.id}:`
    });
    
    await storage.connect();
    instance.storage = storage;
    
    // create blockchain
    const blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    instance.blockchain = blockchain;
    
    // create mempool
    const mempool = new Mempool(storage, chainConfig);
    instance.mempool = mempool;
    
    // create p2p node
    const node = new BoltNode({
      port: config.port,
      chainConfig,
      bootstrapPeers: config.bootstrapPeers || [],
      enableDHT: true,
      enableGossipsub: true,
      peerId: path.join(dataDir, 'peer-id.json')
    });
    instance.node = node;
    
    // create sync service
    const sync = new SyncService({
      blockchain,
      node,
      syncBatchSize: 10,
      syncTimeout: 5000,
      maxReorgDepth: 100
    });
    instance.sync = sync;
    
    // create mempool sync
    const mempoolSync = new MempoolSync({
      mempool,
      node,
      syncInterval: 1000,
      maxTxPerMessage: 10,
      maxInventorySize: 100
    });
    instance.mempoolSync = mempoolSync;
    
    // create api server
    const api = new ApiServer({
      port: config.apiPort,
      blockchain,
      mempool,
      node
    });
    instance.api = api;
    
    // create miner if role is miner
    if (config.role === 'miner') {
      const minerAddress = generateAddress();
      const miner = new MiningService({
        blockchain,
        mempool,
        minerAddress: minerAddress.address,
        autoStart: true
      });
      instance.miner = miner;
      logger.info(`Miner address for ${config.id}: ${minerAddress.address}`);
    }
    
    // start services
    await node.start();
    await sync.start();
    mempoolSync.start();
    await api.start();
    
    if (instance.miner) {
      instance.miner.start();
    }
    
    instance.running = true;
    this.nodes.set(config.id, instance);
    
    logger.info(`Node ${config.id} started successfully`);
    return instance;
  }
  
  async spawnNodeProcess(config: NodeConfig): Promise<NodeInstance> {
    logger.info(`Spawning node process ${config.id}`);
    
    const instance: NodeInstance = {
      config,
      running: false
    };
    
    // create data directory
    const dataDir = config.dataDir || path.join(this.baseDir, config.id);
    this.ensureDirectory(dataDir);
    
    // prepare environment variables
    const env = {
      ...process.env,
      NODE_ID: config.id,
      NODE_ROLE: config.role,
      P2P_PORT: config.port.toString(),
      API_PORT: config.apiPort.toString(),
      METRICS_PORT: config.metricsPort.toString(),
      DATA_DIR: dataDir,
      BOOTSTRAP_PEERS: (config.bootstrapPeers || []).join(','),
      LOG_LEVEL: 'info'
    };
    
    // spawn node process
    const nodeScript = path.join(__dirname, 'start-node.ts');
    const child = spawn('bun', [nodeScript], {
      env,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    instance.process = child;
    
    // handle output
    child.stdout?.on('data', (data) => {
      logger.info(`[${config.id}] ${data.toString().trim()}`);
    });
    
    child.stderr?.on('data', (data) => {
      logger.error(`[${config.id}] ${data.toString().trim()}`);
    });
    
    child.on('exit', (code) => {
      logger.info(`Node ${config.id} exited with code ${code}`);
      instance.running = false;
    });
    
    // wait for node to start
    await this.waitForNode(config.apiPort, 30000);
    
    instance.running = true;
    this.nodes.set(config.id, instance);
    
    logger.info(`Node process ${config.id} started`);
    return instance;
  }
  
  private async waitForNode(apiPort: number, timeout: number): Promise<void> {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      try {
        const response = await fetch(`http://localhost:${apiPort}/health`);
        if (response.ok) {
          return;
        }
      } catch (error) {
        // node not ready yet
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`Node on port ${apiPort} failed to start within ${timeout}ms`);
  }
  
  async stopNode(nodeId: string): Promise<void> {
    const instance = this.nodes.get(nodeId);
    if (!instance) {
      logger.warn(`Node ${nodeId} not found`);
      return;
    }
    
    logger.info(`Stopping node ${nodeId}`);
    
    if (instance.process) {
      // stop spawned process
      instance.process.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (instance.process.killed === false) {
        instance.process.kill('SIGKILL');
      }
    } else {
      // stop in-process node
      if (instance.miner) {
        instance.miner.stop();
      }
      
      if (instance.api) {
        await instance.api.stop();
      }
      
      if (instance.mempoolSync) {
        instance.mempoolSync.stop();
      }
      
      if (instance.sync) {
        instance.sync.stop();
      }
      
      if (instance.node) {
        await instance.node.stop();
      }
      
      if (instance.storage) {
        await instance.storage.close();
      }
    }
    
    instance.running = false;
    this.nodes.delete(nodeId);
    logger.info(`Node ${nodeId} stopped`);
  }
  
  async stopAllNodes(): Promise<void> {
    logger.info('Stopping all nodes...');
    
    const stopPromises: Promise<void>[] = [];
    for (const nodeId of this.nodes.keys()) {
      stopPromises.push(this.stopNode(nodeId));
    }
    
    await Promise.all(stopPromises);
    logger.info('All nodes stopped');
  }
  
  async cleanup(): Promise<void> {
    logger.info('Cleaning up test harness...');
    
    await this.stopAllNodes();
    
    // cleanup data directory
    if (fs.existsSync(this.baseDir)) {
      fs.rmSync(this.baseDir, { recursive: true, force: true });
    }
    
    logger.info('Test harness cleaned up');
  }
  
  getNode(nodeId: string): NodeInstance | undefined {
    return this.nodes.get(nodeId);
  }
  
  getAllNodes(): NodeInstance[] {
    return Array.from(this.nodes.values());
  }
  
  getRunningNodes(): NodeInstance[] {
    return Array.from(this.nodes.values()).filter(n => n.running);
  }
  
  async waitForPeers(nodeId: string, minPeers: number, timeout: number = 30000): Promise<void> {
    const instance = this.nodes.get(nodeId);
    if (!instance || !instance.node) {
      throw new Error(`Node ${nodeId} not found`);
    }
    
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      const peers = instance.node.getPeers();
      if (peers.length >= minPeers) {
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`Node ${nodeId} failed to connect to ${minPeers} peers within ${timeout}ms`);
  }
  
  async waitForHeight(nodeId: string, targetHeight: number, timeout: number = 60000): Promise<void> {
    const instance = this.nodes.get(nodeId);
    if (!instance || !instance.blockchain) {
      throw new Error(`Node ${nodeId} not found`);
    }
    
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      const height = await instance.blockchain.getHeight();
      if (height >= targetHeight) {
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`Node ${nodeId} failed to reach height ${targetHeight} within ${timeout}ms`);
  }
  
  async getNetworkStats(): Promise<any> {
    const stats = {
      nodes: this.nodes.size,
      running: this.getRunningNodes().length,
      nodeStats: [] as any[]
    };
    
    for (const instance of this.nodes.values()) {
      if (!instance.running) continue;
      
      const nodeStats: any = {
        id: instance.config.id,
        role: instance.config.role,
        peers: 0,
        height: 0,
        mempoolSize: 0
      };
      
      if (instance.node) {
        nodeStats.peers = instance.node.getPeers().length;
      }
      
      if (instance.blockchain) {
        nodeStats.height = await instance.blockchain.getHeight();
      }
      
      if (instance.mempool) {
        nodeStats.mempoolSize = instance.mempool.getTransactionCount();
      }
      
      stats.nodeStats.push(nodeStats);
    }
    
    return stats;
  }
}

// cli interface for manual testing
if (import.meta.main) {
  const harness = new E2ETestHarness();
  
  async function main() {
    try {
      logger.info('Starting e2e test harness...');
      
      // spawn bootstrap node
      const bootstrap = await harness.spawnNode({
        id: 'bootstrap',
        port: 17000,
        apiPort: 7000,
        metricsPort: 9000,
        role: 'bootstrap'
      });
      
      const bootstrapAddrs = await bootstrap.node!.getMultiaddrs();
      logger.info(`Bootstrap addresses: ${bootstrapAddrs.join(', ')}`);
      
      // spawn miner nodes
      await harness.spawnNode({
        id: 'miner1',
        port: 17001,
        apiPort: 7001,
        metricsPort: 9001,
        role: 'miner',
        bootstrapPeers: bootstrapAddrs
      });
      
      await harness.spawnNode({
        id: 'miner2',
        port: 17002,
        apiPort: 7002,
        metricsPort: 9002,
        role: 'miner',
        bootstrapPeers: bootstrapAddrs
      });
      
      // spawn full node
      await harness.spawnNode({
        id: 'full1',
        port: 17003,
        apiPort: 7003,
        metricsPort: 9003,
        role: 'full',
        bootstrapPeers: bootstrapAddrs
      });
      
      // wait for network formation
      logger.info('Waiting for network formation...');
      await harness.waitForPeers('miner1', 2);
      await harness.waitForPeers('miner2', 2);
      await harness.waitForPeers('full1', 1);
      
      // monitor network
      setInterval(async () => {
        const stats = await harness.getNetworkStats();
        logger.info('Network stats:', stats);
      }, 10000);
      
      // keep running
      logger.info('Test harness running. Press Ctrl+C to stop.');
      
    } catch (error) {
      logger.error('Test harness error:', error);
      await harness.cleanup();
      process.exit(1);
    }
  }
  
  // handle shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down test harness...');
    await harness.cleanup();
    process.exit(0);
  });
  
  main();
}