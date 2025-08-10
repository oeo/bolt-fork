import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { BoltNode } from '../../src/network/node';
import { 
  MessageFactory, 
  MessageValidator, 
  MessageSerializer,
  MessageType 
} from '../../src/network/messages';
import { 
  BootstrapManager, 
  getBootstrapNodes,
  getNetworkBootstrapConfig 
} from '../../src/network/bootstrap';
import { config as chainConfig } from '../../src/config/chain';

describe('network messages', () => {
  
  describe('message factory', () => {
    test('should create bolt version message', () => {
      const msg = MessageFactory.createBoltVersion(
        1,
        'abc123def456',
        'testnet',
        100,
        1000000n,
        ['mining', 'full_node']
      );

      expect(msg.type).toBe(MessageType.BOLT_VERSION);
      expect(msg.protocolVersion).toBe(1);
      expect(msg.chainVersionHash).toBe('abc123def456');
      expect(msg.network).toBe('testnet');
      expect(msg.height).toBe(100);
      expect(msg.cumulativeDifficulty).toBe(1000000n);
      expect(msg.services).toEqual(['mining', 'full_node']);
      expect(msg.userAgent).toBe('bolt-node/0.1.0');
      expect(msg.timestamp).toBeGreaterThan(0);
      expect(msg.nonce).toBeDefined();
    });

    test('should create new block message with bigint values', () => {
      const block = {
        index: 100,
        hash: 'blockhash123',
        previousHash: 'prevhash456',
        timestamp: Date.now(),
        difficulty: 10,
        nonce: 12345,
        merkleRoot: 'merkle789',
        chainVersionHash: 'chain123',
        transactions: []
      };

      const msg = MessageFactory.createNewBlock(
        block,
        500_000_000n, // 5 BOLT in watts
        5_000_000_000n // 50 BOLT reward
      );

      expect(msg.type).toBe(MessageType.NEW_BLOCK);
      expect(msg.block).toEqual(block);
      expect(msg.totalFees).toBe(500_000_000n);
      expect(msg.minerReward).toBe(5_000_000_000n);
    });

    test('should create node status message', () => {
      const msg = MessageFactory.createNodeStatus(
        1000,
        'latesthash',
        15,
        999999n,
        25,
        1024000,
        8,
        75,
        1_000_000n
      );

      expect(msg.type).toBe(MessageType.NODE_STATUS);
      expect(msg.height).toBe(1000);
      expect(msg.bestBlockHash).toBe('latesthash');
      expect(msg.difficulty).toBe(15);
      expect(msg.cumulativeDifficulty).toBe(999999n);
      expect(msg.mempoolSize).toBe(25);
      expect(msg.mempoolBytes).toBe(1024000);
      expect(msg.connectedPeers).toBe(8);
      expect(msg.syncProgress).toBe(75);
      expect(msg.hashRate).toBe(1_000_000n);
    });

    test('should create ping/pong messages with block height', () => {
      const ping = MessageFactory.createPing(500);
      expect(ping.type).toBe(MessageType.PING);
      expect(ping.blockHeight).toBe(500);

      const pong = MessageFactory.createPong(501);
      expect(pong.type).toBe(MessageType.PONG);
      expect(pong.blockHeight).toBe(501);
    });
  });

  describe('message validator', () => {
    test('should validate bolt version message', () => {
      const validMsg = MessageFactory.createBoltVersion(
        1,
        '0'.repeat(64),
        'mainnet',
        100,
        1000n,
        []
      );

      const result = MessageValidator.validate(validMsg);
      expect(result.valid).toBe(true);
    });

    test('should reject invalid protocol version', () => {
      const msg = MessageFactory.createBoltVersion(
        999, // invalid version
        '0'.repeat(64),
        'mainnet',
        100,
        1000n,
        []
      );

      const result = MessageValidator.validate(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported protocol version');
    });

    test('should reject invalid chain version hash', () => {
      const msg = MessageFactory.createBoltVersion(
        1,
        'invalid', // too short
        'mainnet',
        100,
        1000n,
        []
      );

      const result = MessageValidator.validate(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid chain version hash');
    });

    test('should reject negative values', () => {
      const msg = MessageFactory.createNewBlock(
        {
          index: 100,
          hash: 'hash',
          previousHash: 'prev',
          timestamp: Date.now(),
          difficulty: 10,
          nonce: 0,
          merkleRoot: 'merkle',
          chainVersionHash: 'chain',
          transactions: []
        },
        -100n, // negative fee
        1000n
      );

      const result = MessageValidator.validate(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid fee or reward amounts');
    });

    test('should reject old messages', () => {
      const msg = MessageFactory.createPing();
      msg.timestamp = Date.now() - 120000; // 2 minutes old

      const result = MessageValidator.validate(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('timestamp too old');
    });

    test('should validate block range requests', () => {
      const validMsg = MessageFactory.createGetBlocks(0, 100, 50);
      expect(MessageValidator.validate(validMsg).valid).toBe(true);

      const invalidMsg = MessageFactory.createGetBlocks(100, 50); // end < start
      expect(MessageValidator.validate(invalidMsg).valid).toBe(false);

      const tooLargeMsg = MessageFactory.createGetBlocks(0, 1000); // > 500 blocks
      expect(MessageValidator.validate(tooLargeMsg).valid).toBe(false);
    });
  });

  describe('message serializer', () => {
    test('should serialize and deserialize messages with bigint', () => {
      const original = MessageFactory.createNodeStatus(
        1000,
        'hash123',
        20,
        999_999_999n,
        10,
        50000,
        5,
        80,
        2_000_000n
      );

      const serialized = MessageSerializer.serialize(original);
      const deserialized = MessageSerializer.deserialize(serialized);

      expect(deserialized.type).toBe(original.type);
      expect(deserialized.height).toBe(original.height);
      expect(deserialized.cumulativeDifficulty).toBe(999_999_999n);
      expect(deserialized.hashRate).toBe(2_000_000n);
    });

    test('should handle transaction messages with bigint amounts', () => {
      const tx = {
        hash: 'txhash123',
        from: 'address1',
        to: 'address2',
        amount: 100_000_000_000n, // 1000 BOLT
        fee: 1_000_000n, // 0.01 BOLT
        nonce: 5,
        timestamp: Date.now()
      };

      const msg = MessageFactory.createNewTx(tx, 100n);
      const serialized = MessageSerializer.serialize(msg);
      const deserialized = MessageSerializer.deserialize(serialized);

      expect(deserialized.transaction.amount).toBe(100_000_000_000n);
      expect(deserialized.transaction.fee).toBe(1_000_000n);
      expect(deserialized.feePerByte).toBe(100n);
    });

    test('should calculate message hash for deduplication', () => {
      const msg1 = MessageFactory.createPing();
      const msg2 = MessageFactory.createPing();

      const hash1 = MessageSerializer.getMessageHash(msg1);
      const hash2 = MessageSerializer.getMessageHash(msg2);

      expect(hash1).not.toBe(hash2); // different nonces
      expect(hash1.length).toBe(64); // sha256 hex
    });

    test('should throw on invalid message format', () => {
      const invalidData = new TextEncoder().encode('{"invalid": "message"}');
      
      expect(() => {
        MessageSerializer.deserialize(invalidData);
      }).toThrow('Invalid message format');
    });
  });
});

describe('bootstrap configuration', () => {
  
  test('should get network-specific bootstrap config', () => {
    const mainnetConfig = getNetworkBootstrapConfig();
    expect(mainnetConfig.useBoltNodes).toBe(true);
    expect(mainnetConfig.useIpfsNodes).toBe(true);
    expect(mainnetConfig.useLocalNodes).toBe(false);

    // test with env override
    process.env.BOLT_NETWORK = 'devnet';
    const devnetConfig = getNetworkBootstrapConfig();
    expect(devnetConfig.useBoltNodes).toBe(false);
    expect(devnetConfig.useIpfsNodes).toBe(false);
    expect(devnetConfig.useLocalNodes).toBe(true);
    delete process.env.BOLT_NETWORK;
  });

  test('should manage bootstrap nodes', async () => {
    const manager = new BootstrapManager({
      useBoltNodes: false,
      useIpfsNodes: true,
      useLocalNodes: false
    });

    const nodes = await manager.getNodes();
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]).toContain('/dnsaddr/bootstrap.libp2p.io');
  });

  test('should track healthy and unhealthy nodes', async () => {
    const manager = new BootstrapManager();
    
    const testNode = '/ip4/127.0.0.1/tcp/4001/p2p/TestPeer';
    
    manager.markHealthy(testNode);
    let stats = manager.getStats();
    expect(stats.healthy).toBe(1);
    expect(stats.unhealthy).toBe(0);

    manager.markUnhealthy(testNode);
    stats = manager.getStats();
    expect(stats.healthy).toBe(0);
    expect(stats.unhealthy).toBe(1);
  });

  test('should prioritize custom nodes', async () => {
    const customNodes = [
      '/ip4/192.168.1.1/tcp/26656/p2p/Custom1',
      '/ip4/192.168.1.2/tcp/26656/p2p/Custom2'
    ];

    const manager = new BootstrapManager({
      customNodes,
      useBoltNodes: false,
      useIpfsNodes: false
    });

    const nodes = await manager.getNodes();
    expect(nodes[0]).toBe(customNodes[0]);
    expect(nodes[1]).toBe(customNodes[1]);
  });

  test('should fallback to ipfs nodes when bolt nodes unavailable', async () => {
    const nodes = await getBootstrapNodes({
      useBoltNodes: true, // but no bolt nodes exist yet
      useIpfsNodes: true,
      useLocalNodes: false
    });

    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.some(n => n.includes('libp2p.io'))).toBe(true);
  });
});

describe('bolt node', () => {
  let node: BoltNode;

  afterEach(async () => {
    if (node && node.isStarted()) {
      await node.stop();
    }
  });

  test('should create bolt node instance', () => {
    node = new BoltNode({
      chainConfig,
      port: 26656,
      enableDHT: false,
      enableGossipsub: false
    });

    expect(node).toBeDefined();
    expect(node.isStarted()).toBe(false);
  });

  test('should define protocol and topic constants', () => {
    expect(BoltNode.TOPIC_BLOCKS).toBe('/bolt/blocks/1.0.0');
    expect(BoltNode.TOPIC_TRANSACTIONS).toBe('/bolt/transactions/1.0.0');
    expect(BoltNode.TOPIC_PEER_DISCOVERY).toBe('/bolt/peers/1.0.0');
    expect(BoltNode.PROTOCOL_VERSION).toBe('/bolt/version/1.0.0');
    expect(BoltNode.PROTOCOL_BLOCK_SYNC).toBe('/bolt/sync/blocks/1.0.0');
  });

  // note: full integration tests would require actual libp2p connections
  // which are better suited for integration tests
});