import { describe, test, expect } from 'bun:test';
import { BoltNode } from '../../src/network/node';
import { config as chainConfig } from '../../src/config/chain';

describe('P2P Components', () => {
  
  test('should create BoltNode instance without starting', () => {
    const node = new BoltNode({
      port: 17334,
      chainConfig,
      enableDHT: false,
      enableGossipsub: false
    });

    expect(node).toBeDefined();
    expect(node.isStarted()).toBe(false);
  });

  test('should have correct protocol constants', () => {
    expect(BoltNode.TOPIC_BLOCKS).toBe('/bolt/blocks/1.0.0');
    expect(BoltNode.TOPIC_TRANSACTIONS).toBe('/bolt/transactions/1.0.0');
    expect(BoltNode.TOPIC_PEER_DISCOVERY).toBe('/bolt/peers/1.0.0');
    expect(BoltNode.PROTOCOL_VERSION).toBe('/bolt/version/1.0.0');
    expect(BoltNode.PROTOCOL_BLOCK_SYNC).toBe('/bolt/sync/blocks/1.0.0');
    expect(BoltNode.PROTOCOL_TX_SYNC).toBe('/bolt/sync/tx/1.0.0');
    expect(BoltNode.PROTOCOL_STATUS).toBe('/bolt/status/1.0.0');
  });

  test('should handle event emitter functionality', (done) => {
    const node = new BoltNode({
      port: 17334,
      chainConfig
    });

    const testData = { test: 'data' };
    
    node.once('test-event', (data) => {
      expect(data).toEqual(testData);
      done();
    });

    node.emit('test-event', testData);
  });

  test('should throw when broadcasting without starting', async () => {
    const node = new BoltNode({
      port: 17334,
      chainConfig
    });

    expect(node.isStarted()).toBe(false);

    await expect(node.broadcastBlock({ test: 'block' })).rejects.toThrow('Node not started');
    await expect(node.broadcastTransaction({ test: 'tx' })).rejects.toThrow('Node not started');
  });

  test('should return empty arrays when not started', () => {
    const node = new BoltNode({
      port: 17334,
      chainConfig
    });

    expect(node.getPeers()).toEqual([]);
    expect(node.getMultiaddrs()).toEqual([]);
  });

  test('should throw when getting stats without starting', () => {
    const node = new BoltNode({
      port: 17334,
      chainConfig
    });

    expect(() => node.getStats()).toThrow('Node not started');
  });
});