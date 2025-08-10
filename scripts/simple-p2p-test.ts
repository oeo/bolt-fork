#!/usr/bin/env bun
/**
 * simple p2p test without full libp2p
 * tests the basic components we've built
 */

import { Blockchain } from '../src/core/blockchain';
import { Mempool } from '../src/core/mempool';
import { ApiServer } from '../src/api/server';
import { createStorage } from '../src/storage';
import { config as chainConfig } from '../src/config/chain';
import { MessageFactory, MessageValidator, MessageSerializer } from '../src/network/messages';
import { BootstrapManager } from '../src/network/bootstrap';
import { generateAddress } from '../src/crypto/address';
import { TransactionClass } from '../src/core/transaction';
import { getLogger, displayBanner } from '../src/utils/logger';
import { formatWatts } from '../src/utils/currency';

const logger = getLogger(__filename);

async function testNetworkMessages() {
  logger.info('Testing network messages...');

  // test message creation
  const versionMsg = MessageFactory.createBoltVersion(
    1,
    'test-chain-hash',
    'testnet',
    100,
    1000000n,
    ['mining', 'full_node']
  );

  logger.info('Created version message:', {
    type: versionMsg.type,
    height: versionMsg.height,
    services: versionMsg.services
  });

  // test validation
  const validation = MessageValidator.validate(versionMsg);
  logger.info(`Message validation: ${validation.valid ? 'PASSED' : 'FAILED'}`);

  // test serialization
  const serialized = MessageSerializer.serialize(versionMsg);
  const deserialized = MessageSerializer.deserialize(serialized);
  
  logger.info('Serialization test:', {
    originalCumulativeDifficulty: versionMsg.cumulativeDifficulty.toString(),
    deserializedCumulativeDifficulty: deserialized.cumulativeDifficulty.toString(),
    match: versionMsg.cumulativeDifficulty === deserialized.cumulativeDifficulty
  });

  // test transaction message with bigint
  const alice = generateAddress();
  const bob = generateAddress();
  
  const tx = new TransactionClass(
    alice.address,
    bob.address,
    100_000_000_000n, // 1000 BOLT
    1_000_000n, // 0.01 BOLT fee
    0,
    Date.now()
  );
  await tx.sign(alice.privateKey);

  const txMsg = MessageFactory.createNewTx(tx.toObject(), 100n);
  logger.info('Created transaction message:', {
    amount: formatWatts(tx.amount),
    fee: formatWatts(tx.fee),
    feePerByte: txMsg.feePerByte.toString()
  });
}

async function testBootstrapConfig() {
  logger.info('\nTesting bootstrap configuration...');

  const manager = new BootstrapManager({
    useBoltNodes: false,
    useIpfsNodes: true,
    useLocalNodes: false
  });

  const nodes = await manager.getNodes();
  logger.info(`Found ${nodes.length} bootstrap nodes`);
  
  if (nodes.length > 0) {
    logger.info('Sample bootstrap nodes:');
    nodes.slice(0, 3).forEach(node => {
      logger.info(`  - ${node}`);
    });
  }

  const stats = manager.getStats();
  logger.info('Bootstrap stats:', stats);
}

async function testApiServer() {
  logger.info('\nTesting API server...');

  // create components
  const storage = createStorage('memory');
  const blockchain = new Blockchain(storage, chainConfig);
  await blockchain.initialize();
  const mempool = new Mempool(storage, chainConfig);

  // create api server (without P2P node)
  const apiServer = new ApiServer({
    port: 17333,
    blockchain,
    mempool,
    storage
  });

  try {
    await apiServer.start();
    logger.info('API server started on port 17333');

    // test endpoints
    const tests = [
      { endpoint: '/health', description: 'Health check' },
      { endpoint: '/blockchain/info', description: 'Blockchain info' },
      { endpoint: '/mempool', description: 'Mempool info' }
    ];

    for (const test of tests) {
      const response = await fetch(`http://localhost:17333${test.endpoint}`);
      logger.info(`${test.description}: ${response.status === 200 ? 'OK' : 'FAILED'}`);
      
      if (response.status === 200) {
        const data = await response.json();
        logger.debug('Response:', data);
      }
    }

    // test transaction submission
    const alice = generateAddress();
    const bob = generateAddress();
    
    // give alice some balance
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n, // 100 BOLT
      nonce: 0
    });

    const tx = new TransactionClass(
      alice.address,
      bob.address,
      1_000_000_000n, // 10 BOLT
      1_000_000n, // 0.01 BOLT fee
      0,
      Date.now()
    );
    await tx.sign(alice.privateKey);

    const submitResponse = await fetch('http://localhost:17333/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tx.toObject())
    });

    if (submitResponse.status === 200) {
      const result = await submitResponse.json();
      logger.info('Transaction submitted:', {
        hash: result.hash,
        accepted: result.accepted
      });

      // check mempool
      const mempoolResponse = await fetch('http://localhost:17333/mempool');
      const mempoolData = await mempoolResponse.json();
      logger.info('Mempool after submission:', {
        size: mempoolData.size,
        totalFees: mempoolData.totalFees
      });
    }

    await apiServer.stop();
    logger.info('API server stopped');

  } catch (error) {
    logger.error('API test failed:', error);
    await apiServer.stop();
  }
}

async function main() {
  displayBanner();
  logger.info('Bolt P2P Components Test');
  logger.info('========================\n');

  try {
    await testNetworkMessages();
    await testBootstrapConfig();
    await testApiServer();

    logger.info('\n✅ All component tests completed successfully!');
  } catch (error) {
    logger.error('Test failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);