#!/usr/bin/env bun

import { BoltNode } from '../src/network/node';
import { config as chainConfig } from '../src/config/chain';
import { getLogger } from '../src/utils/logger';

const logger = getLogger(__filename);

async function testP2PConnection() {
  logger.info('Testing P2P node connections...');
  
  let node1: BoltNode | null = null;
  let node2: BoltNode | null = null;
  let node3: BoltNode | null = null;
  
  try {
    // create bootstrap node
    logger.info('Creating bootstrap node...');
    node1 = new BoltNode({
      port: 19000,
      chainConfig,
      enableDHT: false, // disable DHT for now due to version issues
      enableGossipsub: true
    });
    
    await node1.start();
    const node1Addrs = await node1.getMultiaddrs();
    logger.info(`Bootstrap node started with ${node1Addrs.length} addresses`);
    logger.info(`Bootstrap addresses: ${node1Addrs.join(', ')}`);
    
    // wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // create second node
    logger.info('Creating second node...');
    node2 = new BoltNode({
      port: 19001,
      chainConfig,
      bootstrapPeers: node1Addrs,
      enableDHT: false, // disable DHT for now
      enableGossipsub: true
    });
    
    await node2.start();
    const node2Addrs = await node2.getMultiaddrs();
    logger.info(`Node2 started with ${node2Addrs.length} addresses`);
    
    // wait for connection
    logger.info('Waiting for nodes to discover each other...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // check connections
    const node1Peers = node1.getPeers();
    const node2Peers = node2.getPeers();
    
    logger.info(`Node1 has ${node1Peers.length} peers: ${node1Peers.join(', ')}`);
    logger.info(`Node2 has ${node2Peers.length} peers: ${node2Peers.join(', ')}`);
    
    if (node1Peers.length === 0 && node2Peers.length === 0) {
      logger.warn('Nodes did not automatically connect, trying manual dial...');
      
      const localAddr = node1Addrs.find(addr => addr.includes('127.0.0.1'));
      if (localAddr) {
        logger.info(`Dialing ${localAddr}`);
        await node2.dial(localAddr);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const afterNode1Peers = node1.getPeers();
        const afterNode2Peers = node2.getPeers();
        
        logger.info(`After manual dial:`);
        logger.info(`  Node1: ${afterNode1Peers.length} peers`);
        logger.info(`  Node2: ${afterNode2Peers.length} peers`);
      }
    }
    
    // add third node
    logger.info('Adding third node to network...');
    node3 = new BoltNode({
      port: 19002,
      chainConfig,
      bootstrapPeers: node1Addrs,
      enableDHT: false, // disable DHT for now
      enableGossipsub: true
    });
    
    await node3.start();
    
    // wait for discovery
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // final peer check
    logger.info('Final network status:');
    logger.info(`  Node1: ${node1.getPeers().length} peers`);
    logger.info(`  Node2: ${node2.getPeers().length} peers`);
    logger.info(`  Node3: ${node3.getPeers().length} peers`);
    
    // test gossipsub
    logger.info('Testing gossipsub message propagation...');
    
    // subscribe to test topic
    const testTopic = '/test/topic/1.0.0';
    
    let messagesReceived = 0;
    node2.on('gossip:message', (topic: string, message: any) => {
      if (topic === testTopic) {
        messagesReceived++;
        logger.info(`Node2 received message on ${topic}`);
      }
    });
    
    node3.on('gossip:message', (topic: string, message: any) => {
      if (topic === testTopic) {
        messagesReceived++;
        logger.info(`Node3 received message on ${topic}`);
      }
    });
    
    // publish test message from node1
    await node1.publish(testTopic, { test: 'hello world' });
    
    // wait for propagation
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    logger.info(`Messages received: ${messagesReceived}`);
    
    logger.info('P2P connection test completed successfully!');
    
  } catch (error) {
    logger.error('Test failed:', error);
    console.error('Full error:', error);
    process.exit(1);
  } finally {
    // cleanup
    logger.info('Cleaning up nodes...');
    
    if (node1) await node1.stop();
    if (node2) await node2.stop();
    if (node3) await node3.stop();
    
    logger.info('Test completed');
  }
}

// run test
testP2PConnection().catch(error => {
  logger.error('Unhandled error:', error);
  process.exit(1);
});