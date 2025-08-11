#!/usr/bin/env bun
/**
 * p2p network demonstration
 * shows bolt nodes discovering each other and exchanging messages
 */

import { BoltNode } from '../src/network/node';
import { ApiServer } from '../src/api/server';
import { Blockchain } from '../src/core/blockchain';
import { Mempool } from '../src/core/mempool';
import { createStorage } from '../src/storage';
import { config as chainConfig } from '../src/config/chain';
import { getLogger, displayBanner } from '../src/utils/logger';
import { generateAddress } from '../src/crypto/address';
import { TransactionClass } from '../src/core/transaction';
import { BlockClass } from '../src/core/block';
import { formatWatts } from '../src/utils/currency';

const logger = getLogger(__filename);

// node configuration
interface NodeConfig {
  name: string;
  p2pPort: number;
  apiPort: number;
  minerAddress: string;
}

// create a complete bolt node with all components
async function createBoltNode(nodeConfig: NodeConfig) {
  logger.info(`Creating ${nodeConfig.name}...`);

  // create storage (memory for demo)
  const storage = createStorage('memory');

  // create blockchain
  const blockchain = new Blockchain(storage, chainConfig);
  await blockchain.initialize();

  // create mempool
  const mempool = new Mempool(storage, chainConfig);

  // create p2p node
  const p2pNode = new BoltNode({
    port: nodeConfig.p2pPort,
    chainConfig,
    enableDHT: true,
    enableGossipsub: true
  });

  // create api server
  const apiServer = new ApiServer({
    port: nodeConfig.apiPort,
    blockchain,
    mempool,
    node: p2pNode,
    storage
  });

  // set up message handlers
  p2pNode.on('block', async (block: any) => {
    logger.info(`${nodeConfig.name} received block ${block.index}`);
    // validate and add block
    const blockClass = BlockClass.fromObject(block);
    const result = await blockchain.addBlock(blockClass);
    if (result.valid) {
      logger.info(`${nodeConfig.name} accepted block ${block.index}`);
    } else {
      logger.warn(`${nodeConfig.name} rejected block: ${result.error}`);
    }
  });

  p2pNode.on('transaction', async (tx: any) => {
    logger.info(`${nodeConfig.name} received transaction ${tx.hash}`);
    // add to mempool
    const result = await mempool.addTransaction(tx);
    if (result.valid) {
      logger.info(`${nodeConfig.name} added tx to mempool`);
    } else {
      logger.warn(`${nodeConfig.name} rejected tx: ${result.error}`);
    }
  });

  return { blockchain, mempool, p2pNode, apiServer, storage };
}

// simulate network activity
async function simulateActivity(nodes: any[]) {
  logger.info('Starting network activity simulation...');

  // generate some addresses
  const alice = generateAddress();
  const bob = generateAddress();
  const charlie = generateAddress();

  logger.info(`Alice address: ${alice.address}`);
  logger.info(`Bob address: ${bob.address}`);
  logger.info(`Charlie address: ${charlie.address}`);

  // give alice some initial balance (simulating previous mining)
  const node1 = nodes[0];
  await node1.storage.updateAccountState(alice.address, {
    balance: 10_000_000_000n, // 100 BOLT
    nonce: 0
  });

  // create and broadcast a transaction from alice to bob
  logger.info('Creating transaction from Alice to Bob...');
  const tx1 = new TransactionClass(
    alice.address,
    bob.address,
    1_000_000_000n, // 10 BOLT
    1_000_000n, // 0.01 BOLT fee
    0, // nonce
    Date.now()
  );
  await tx1.sign(alice.privateKey);

  // add to node1's mempool and broadcast
  const result = await node1.mempool.addTransaction(tx1.toObject());
  if (result.valid) {
    logger.info('Transaction added to mempool');
    await node1.p2pNode.broadcastTransaction(tx1.toObject());
    logger.info('Transaction broadcast to network');
  }

  // wait for propagation
  await new Promise(resolve => setTimeout(resolve, 2000));

  // check if other nodes received it
  for (let i = 1; i < nodes.length; i++) {
    const tx = nodes[i].mempool.getTransaction(tx1.hash);
    if (tx) {
      logger.info(`Node${i + 1} has transaction in mempool`);
    }
  }

  // simulate mining a block on node1
  logger.info('Mining a block on Node1...');
  const mempoolTxs = node1.mempool.getTransactionsForBlock(1000000);
  const template = await node1.blockchain.createBlockTemplate(
    mempoolTxs,
    nodes[0].minerAddress
  );

  const newBlock = new BlockClass(
    template.height,
    Date.now(),
    template.previousHash,
    template.transactions,
    template.difficulty,
    nodes[0].minerAddress
  );

  // mine with low difficulty for demo
  const mined = newBlock.mine('sha256', 100000);
  if (mined) {
    logger.info(`Block ${newBlock.index} mined with hash ${newBlock.hash}`);
    
    // add to local blockchain
    const addResult = await node1.blockchain.addBlock(newBlock);
    if (addResult.valid) {
      // broadcast to network
      await node1.p2pNode.broadcastBlock(newBlock.toObject());
      logger.info('Block broadcast to network');
    }
  }

  // wait for propagation
  await new Promise(resolve => setTimeout(resolve, 2000));

  // check balances on all nodes
  logger.info('\nChecking final balances:');
  for (let i = 0; i < nodes.length; i++) {
    const aliceBalance = await nodes[i].blockchain.getBalance(alice.address);
    const bobBalance = await nodes[i].blockchain.getBalance(bob.address);
    
    logger.info(`Node${i + 1} balances:`);
    logger.info(`  Alice: ${formatWatts(aliceBalance)}`);
    logger.info(`  Bob: ${formatWatts(bobBalance)}`);
  }
}

// main demo
async function main() {
  displayBanner();
  logger.info('Bolt P2P Network Demo');
  logger.info('=====================');

  // create 3 nodes
  const nodeConfigs: NodeConfig[] = [
    {
      name: 'Node1',
      p2pPort: 7334,
      apiPort: 7333,
      minerAddress: generateAddress().address
    },
    {
      name: 'Node2', 
      p2pPort: 7344,
      apiPort: 7343,
      minerAddress: generateAddress().address
    },
    {
      name: 'Node3',
      p2pPort: 7354,
      apiPort: 7353,
      minerAddress: generateAddress().address
    }
  ];

  const nodes = [];

  try {
    // create and start all nodes
    for (const config of nodeConfigs) {
      const node = await createBoltNode(config);
      
      // start p2p node
      await node.p2pNode.start();
      logger.info(`${config.name} P2P listening on port ${config.p2pPort}`);
      
      // start api server
      await node.apiServer.start();
      logger.info(`${config.name} API listening on port ${config.apiPort}`);
      
      nodes.push({ ...node, ...config });
    }

    // wait for nodes to discover each other
    logger.info('\nWaiting for peer discovery...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // connect nodes manually (since we don't have real bootstrap nodes)
    logger.info('Connecting nodes...');
    
    // node2 connects to node1
    const node1Addr = nodes[0].p2pNode.getMultiaddrs()[0];
    await nodes[1].p2pNode.connectToPeer(node1Addr);
    
    // node3 connects to node1
    await nodes[2].p2pNode.connectToPeer(node1Addr);

    // wait for connections
    await new Promise(resolve => setTimeout(resolve, 2000));

    // check peer counts
    logger.info('\nPeer connections:');
    for (let i = 0; i < nodes.length; i++) {
      const peers = nodes[i].p2pNode.getPeers();
      logger.info(`${nodeConfigs[i].name}: ${peers.length} peers connected`);
    }

    // simulate network activity
    await simulateActivity(nodes);

    // show network statistics
    logger.info('\nNetwork Statistics:');
    for (let i = 0; i < nodes.length; i++) {
      const stats = nodes[i].p2pNode.getStats();
      const height = await nodes[i].blockchain.getHeight();
      
      logger.info(`${nodeConfigs[i].name}:`);
      logger.info(`  Chain height: ${height}`);
      logger.info(`  Peers: ${stats.peers}`);
      logger.info(`  Topics: ${stats.subscribedTopics.join(', ')}`);
    }

    // demonstrate api endpoints
    logger.info('\nAPI Endpoints available:');
    logger.info(`  http://localhost:7333/blockchain/info`);
    logger.info(`  http://localhost:7333/network/status`);
    logger.info(`  http://localhost:7333/peers`);
    logger.info(`  http://localhost:7333/mempool`);

    // keep running for manual testing
    logger.info('\nNetwork is running. Press Ctrl+C to stop.');
    
    // api test
    logger.info('\nTesting API endpoint...');
    const response = await fetch('http://localhost:7333/blockchain/info');
    const info = await response.json();
    logger.info('Blockchain info:', info);

  } catch (error) {
    logger.error('Demo failed:', error);
  }
}

// handle shutdown
process.on('SIGINT', async () => {
  logger.info('\nShutting down demo...');
  process.exit(0);
});

// run demo
main().catch(console.error);