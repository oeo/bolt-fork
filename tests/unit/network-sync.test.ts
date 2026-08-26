import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { Blockchain } from '../../src/core/blockchain';
import { BlockClass } from '../../src/core/block';
import { createCoinbaseTransaction, createSignedTransaction } from '../../src/core/transaction';
import { Mempool } from '../../src/core/mempool';
import { devnet } from '../../src/config/chains/devnet';
import { generateAddress } from '../../src/crypto/address';
import { MemoryAdapter } from '../../src/storage/memory';
import { Protocol } from '../../src/network/protocol';
import { SyncManager, type SyncManagerConfig } from '../../src/network/sync-manager';
import { ConnectionManager } from '../../src/network/connection-manager';
import { InventoryManager } from '../../src/network/inventory-manager';
import { TransactionRelay } from '../../src/network/transaction-relay';
import type { NodeIdentity } from '../../src/utils/identity';
import { hexToBytes } from '@noble/hashes/utils';
import type { ChainConfig } from '../../src/config/chain';

const chains: Blockchain[] = [];
const storages = new Map<Blockchain, MemoryAdapter>();

afterEach(async () => {
  await Promise.all(chains.splice(0).map(chain => chain.close()));
  storages.clear();
});

async function createChain(config: ChainConfig = devnet): Promise<Blockchain> {
  const storage = new MemoryAdapter();
  const chain = new Blockchain(storage, config);
  await chain.initialize();
  chains.push(chain);
  storages.set(chain, storage);
  return chain;
}

async function appendBlock(
  chain: Blockchain,
  timestamp?: number,
  miner = generateAddress(devnet.addressPrefix).address,
  config: ChainConfig = devnet
): Promise<BlockClass> {
  const previous = await chain.getLatestBlock();
  const height = previous!.index + 1;
  const blockTimestamp = timestamp ?? Math.max(Date.now(), previous!.timestamp + 1);
  const block = new BlockClass(
    height,
    blockTimestamp,
    previous!.hash,
    [createCoinbaseTransaction(
      config.chainId,
      miner,
      chain.getBlockReward(height),
      0n,
      blockTimestamp
    )],
    await chain.getDifficulty(height),
    miner
  );
  await chain.prepareBlock(block);
  expect(block.mine('sha256', 1_000_000).success).toBe(true);
  expect((await chain.addBlock(block)).valid).toBe(true);
  return block;
}

function header(block: BlockClass) {
  return {
    height: block.index,
    hash: block.hash,
    previousHash: block.previousHash,
    merkleRoot: block.merkleRoot,
    stateRoot: block.stateRoot,
    timestamp: block.timestamp,
    difficulty: block.difficulty,
    nonce: block.nonce
  };
}

async function createSync(
  blockchain: Blockchain,
  config: ChainConfig = devnet,
  overrides: Partial<SyncManagerConfig> = {}
) {
  const identity = { ...generateAddress(config.addressPrefix), createdAt: Date.now() } as NodeIdentity;
  const peer = { nodeId: generateAddress(config.addressPrefix).address, tipHash: '', height: 0 };
  const genesisHash = (await blockchain.getBlock(0))!.hash;
  const protocol = new Protocol({ chainId: config.chainId, genesisHash, maxPayloadSize: config.maxBlockSize });
  const sent: Array<{ peerId: string; command: string; payload: any }> = [];
  const connectionManager = Object.assign(new EventEmitter(), {
    getConnection: (target: string) => target === peer.nodeId || target === 'session'
      ? { id: 'session', authenticated: true }
      : undefined,
    isAuthenticated: () => true,
    sendMessage: (peerId: string, data: Uint8Array) => {
      const message = protocol.decodeMessage(data)!;
      sent.push({ peerId, command: message.command, payload: message.payload });
      return true;
    },
    disconnect: () => {},
    connectToPeer: async () => true,
  });
  const discoveryService = Object.assign(new EventEmitter(), {
    getPeer: (peerId: string) => peerId === peer.nodeId ? peer : undefined,
    getKnownPeers: () => []
  });
  const relay = {
    handled: 0,
    synced: 0,
    handleGetData: () => {},
    handleTransaction: async () => { relay.handled++; return true; },
    syncMempool: async () => { relay.synced++; }
  };
  const inventory = {
    handleInv: async () => [],
    markAnnounced: () => {},
    wasAnnouncedToPeer: () => true
  };
  const sync = new SyncManager({
    blockchain,
    connectionManager: connectionManager as any,
    protocol,
    discoveryService: discoveryService as any,
    chainConfig: config,
    genesisHash,
    identity,
    inventoryManager: inventory as any,
    transactionRelay: relay as any,
    ...overrides
  });
  return { sync, sent, peer, relay, inventory };
}

describe('validated network synchronization', () => {
  it('downloads and admits blocks only after validating greater-work headers', async () => {
    const source = await createChain();
    const target = await createChain();
    const block = await appendBlock(source);
    const { sync, sent, peer } = await createSync(target);
    peer.tipHash = block.hash;
    peer.height = block.index;
    (sync as any).headerRequests.set('session', {
      peerId: peer.nodeId,
      sessionId: 'session',
      deadline: Date.now() + 1000,
      headers: []
    });

    await (sync as any).handleHeaders(peer.nodeId, 'session', [header(block)]);
    expect(sent.at(-1)?.command).toBe('getdata');
    await (sync as any).handleBlock(peer.nodeId, 'session', block.toObject());
    for (let attempt = 0; attempt < 20 && await target.getHeight() !== 1; attempt++) await Bun.sleep(1);

    expect(await target.getHeight()).toBe(1);
    expect((await target.getLatestBlock())?.hash).toBe(block.hash);
  });

  it('does not download a valid candidate with less cumulative work', async () => {
    const source = await createChain();
    const target = await createChain();
    const candidate = await appendBlock(source);
    await appendBlock(target);
    await appendBlock(target);
    const { sync, sent, peer } = await createSync(target);
    (sync as any).headerRequests.set('session', {
      peerId: peer.nodeId,
      sessionId: 'session',
      deadline: Date.now() + 1000,
      headers: []
    });

    await (sync as any).handleHeaders(peer.nodeId, 'session', [header(candidate)]);

    expect(sent.some(message => message.command === 'getdata')).toBe(false);
    expect(await target.getHeight()).toBe(2);
  });

  it('reorganizes to a shorter chain with more validated work', async () => {
    const config = { ...devnet, difficultyAdjustmentInterval: 2 };
    const source = await createChain(config);
    const target = await createChain(config);
    const commonMiner = generateAddress(config.addressPrefix).address;
    const sourceMiner = generateAddress(config.addressPrefix).address;
    const targetMiner = generateAddress(config.addressPrefix).address;
    const base = Date.now();
    const common = await appendBlock(source, base, commonMiner, config);
    expect((await target.addBlock(BlockClass.fromObject(common.toObject()))).valid).toBe(true);

    const sourceBlocks = [
      await appendBlock(source, base + 1000, sourceMiner, config),
      await appendBlock(source, base + 2000, sourceMiner, config),
      await appendBlock(source, base + 3000, sourceMiner, config)
    ];
    await appendBlock(target, base + 1000, targetMiner, config);
    await appendBlock(target, base + 51_000, targetMiner, config);
    await appendBlock(target, base + 52_000, targetMiner, config);
    await appendBlock(target, base + 53_000, targetMiner, config);
    expect(await source.getHeight()).toBe(4);
    expect(await target.getHeight()).toBe(5);
    expect(await source.getCumulativeDifficulty()).toBeGreaterThan(await target.getCumulativeDifficulty());

    const { sync, sent, peer } = await createSync(target, config);
    (sync as any).headerRequests.set('session', {
      peerId: peer.nodeId,
      sessionId: 'session',
      deadline: Date.now() + 1000,
      headers: []
    });
    await (sync as any).handleHeaders(peer.nodeId, 'session', sourceBlocks.map(header));
    expect(sent.at(-1)?.command).toBe('getdata');
    for (const block of sourceBlocks) {
      await (sync as any).handleBlock(peer.nodeId, 'session', block.toObject());
    }
    for (let attempt = 0; attempt < 20 && await target.getHeight() !== 4; attempt++) await Bun.sleep(1);

    expect(await target.getHeight()).toBe(4);
    expect((await target.getLatestBlock())?.hash).toBe(sourceBlocks.at(-1)!.hash);
  });

  it('ignores unsolicited blocks and transactions', async () => {
    const source = await createChain();
    const target = await createChain();
    const block = await appendBlock(source);
    const { sync, peer, relay } = await createSync(target);

    await (sync as any).handleBlock(peer.nodeId, 'session', block.toObject());
    await (sync as any).handleMessage(peer.nodeId, 'session', 'tx', { hash: 'ab'.repeat(32) });

    expect(await target.getHeight()).toBe(0);
    expect(relay.handled).toBe(0);
  });

  it('dispatches each requested transaction once', async () => {
    const target = await createChain();
    const { sync, peer, relay } = await createSync(target);
    const hash = 'ab'.repeat(32);
    (sync as any).transactionRequests.set(hash, {
      peerId: peer.nodeId,
      sessionId: 'session',
      deadline: Date.now() + 1000
    });

    await (sync as any).handleMessage(peer.nodeId, 'session', 'tx', { hash });
    await (sync as any).handleMessage(peer.nodeId, 'session', 'tx', { hash });

    expect(relay.handled).toBe(1);
  });

  it('reserves a header request before building its locator', async () => {
    const target = await createChain();
    const { sync, sent, peer } = await createSync(target);
    let releaseLocator!: () => void;
    const locatorGate = new Promise<void>(resolve => { releaseLocator = resolve; });
    (sync as any).buildBlockLocator = async () => {
      await locatorGate;
      return [(await target.getLatestBlock())!.hash];
    };

    const first = (sync as any).requestHeaders(peer.nodeId);
    await Bun.sleep(0);
    await (sync as any).requestHeaders(peer.nodeId);
    releaseLocator();
    await first;

    expect(sent.filter(message => message.command === 'getheaders')).toHaveLength(1);
  });

  it('does not solicit another header candidate during block synchronization', async () => {
    const target = await createChain();
    const { sync, sent, peer } = await createSync(target);
    (sync as any).activeSync = { headers: [] };

    await (sync as any).requestHeaders(peer.nodeId);

    expect(sent).toHaveLength(0);
  });

  it('reserves the aggregate header limit during concurrent validation', async () => {
    const target = await createChain();
    const { sync, sent, peer } = await createSync(target, devnet, { maxHeaderCandidates: 1 });
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>(resolve => { releaseValidation = resolve; });
    let validations = 0;
    target.validateHeaderChain = async () => {
      validations++;
      await validationGate;
      return { valid: false, error: 'test rejection' };
    };
    for (const sessionId of ['session-a', 'session-b']) {
      (sync as any).headerRequests.set(sessionId, {
        peerId: peer.nodeId,
        sessionId,
        deadline: Date.now() + 1000,
        headers: []
      });
    }
    const payload = [{
      height: 1,
      hash: '1'.repeat(64),
      previousHash: '2'.repeat(64),
      merkleRoot: '3'.repeat(64),
      stateRoot: '4'.repeat(64),
      timestamp: Date.now(),
      difficulty: 1,
      nonce: 0
    }];

    const first = (sync as any).handleHeaders(peer.nodeId, 'session-a', payload);
    await Bun.sleep(0);
    await (sync as any).handleHeaders(peer.nodeId, 'session-b', payload);
    releaseValidation();
    await first;

    expect(validations).toBe(1);
    expect(sent).toHaveLength(0);
    expect((sync as any).headerRequests.has('session-b')).toBe(false);
  });

  it('counts active synchronization against the aggregate header limit', async () => {
    const target = await createChain();
    const { sync, sent, peer } = await createSync(target, devnet, { maxHeaderCandidates: 1 });
    (sync as any).activeSync = { headers: [{}] };
    (sync as any).headerRequests.set('session', {
      peerId: peer.nodeId,
      sessionId: 'session',
      deadline: Date.now() + 1000,
      headers: []
    });

    await (sync as any).handleHeaders(peer.nodeId, 'session', [{
      height: 1,
      hash: '1'.repeat(64),
      previousHash: '2'.repeat(64),
      merkleRoot: '3'.repeat(64),
      stateRoot: '4'.repeat(64),
      timestamp: Date.now(),
      difficulty: 1,
      nonce: 0
    }]);

    expect(sent).toHaveLength(0);
    expect((sync as any).headerRequests.has('session')).toBe(false);
  });

  it('bounds transaction requests per peer session', async () => {
    const target = await createChain();
    const { sync, sent, peer, inventory } = await createSync(target, devnet, {
      maxTransactionRequests: 4,
      maxTransactionRequestsPerPeer: 2
    });
    inventory.handleInv = async () => Array.from({ length: 4 }, (_, index) => ({
      type: 1,
      hash: index.toString(16).padStart(64, '0')
    }));

    await (sync as any).handleInv(peer.nodeId, 'session', []);

    expect(sent.at(-1)?.command).toBe('getdata');
    expect(sent.at(-1)?.payload).toHaveLength(2);
    expect((sync as any).transactionRequests.size).toBe(2);
  });

  it('evicts old announcement authorization at inventory capacity', async () => {
    const target = await createChain();
    const protocol = new Protocol({
      chainId: devnet.chainId,
      genesisHash: (await target.getBlock(0))!.hash,
      maxPayloadSize: devnet.maxBlockSize
    });
    const inventory = new InventoryManager({
      connectionManager: new EventEmitter() as any,
      protocol,
      blockchain: target,
      mempool: new Mempool(storages.get(target)!, devnet),
      maxInventorySize: 2
    });
    const hashes = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];

    inventory.markAnnounced('peer', hashes.map(hash => ({ type: 1, hash })));

    expect(inventory.wasAnnouncedToPeer('peer', 1, hashes[0])).toBe(false);
    expect(inventory.wasAnnouncedToPeer('peer', 1, hashes[2])).toBe(true);
  });

  it('synchronizes validated work and transactions across authenticated tcp nodes', async () => {
    const source = await createChain();
    const target = await createChain();
    const funded = generateAddress(devnet.addressPrefix);
    const block = await appendBlock(source, undefined, funded.address);
    const sourceMempool = new Mempool(storages.get(source)!, devnet);
    const targetMempool = new Mempool(storages.get(target)!, devnet);
    await sourceMempool.initialize();
    await targetMempool.initialize();
    const genesisHash = (await source.getBlock(0))!.hash;
    const sourceIdentity = { ...generateAddress(devnet.addressPrefix), createdAt: Date.now() };
    const targetIdentity = { ...generateAddress(devnet.addressPrefix), createdAt: Date.now() };
    const sourceProtocol = new Protocol({ chainId: devnet.chainId, genesisHash, maxPayloadSize: devnet.maxBlockSize });
    const targetProtocol = new Protocol({ chainId: devnet.chainId, genesisHash, maxPayloadSize: devnet.maxBlockSize });
    const sourceConnections = new ConnectionManager({
      nodeId: sourceIdentity.address,
      tcpPort: 0,
      protocol: sourceProtocol,
      maxMessageSize: devnet.maxBlockSize,
      allowPrivatePeers: true
    });
    const targetConnections = new ConnectionManager({
      nodeId: targetIdentity.address,
      tcpPort: 0,
      protocol: targetProtocol,
      maxMessageSize: devnet.maxBlockSize,
      allowPrivatePeers: true
    });
    const sourcePeers = new Map<string, any>();
    const targetPeers = new Map<string, any>();
    const sourceDiscovery = Object.assign(new EventEmitter(), {
      getPeer: (peerId: string) => sourcePeers.get(peerId),
      getKnownPeers: () => [...sourcePeers.values()]
    });
    const targetDiscovery = Object.assign(new EventEmitter(), {
      getPeer: (peerId: string) => targetPeers.get(peerId),
      getKnownPeers: () => [...targetPeers.values()]
    });
    const sourceInventory = new InventoryManager({
      connectionManager: sourceConnections,
      protocol: sourceProtocol,
      blockchain: source,
      mempool: sourceMempool
    });
    const targetInventory = new InventoryManager({
      connectionManager: targetConnections,
      protocol: targetProtocol,
      blockchain: target,
      mempool: targetMempool
    });
    const sourceRelay = new TransactionRelay({
      mempool: sourceMempool,
      connectionManager: sourceConnections,
      inventoryManager: sourceInventory,
      protocol: sourceProtocol,
      relayInterval: 1
    });
    const targetRelay = new TransactionRelay({
      mempool: targetMempool,
      connectionManager: targetConnections,
      inventoryManager: targetInventory,
      protocol: targetProtocol,
      relayInterval: 1
    });
    const sourceSync = new SyncManager({
      blockchain: source,
      connectionManager: sourceConnections,
      protocol: sourceProtocol,
      discoveryService: sourceDiscovery as any,
      chainConfig: devnet,
      genesisHash,
      identity: sourceIdentity,
      inventoryManager: sourceInventory,
      transactionRelay: sourceRelay
    });
    const targetSync = new SyncManager({
      blockchain: target,
      connectionManager: targetConnections,
      protocol: targetProtocol,
      discoveryService: targetDiscovery as any,
      chainConfig: devnet,
      genesisHash,
      identity: targetIdentity,
      inventoryManager: targetInventory,
      transactionRelay: targetRelay
    });

    sourceRelay.start();
    targetRelay.start();
    await sourceSync.start();
    await targetSync.start();
    await sourceConnections.start();
    await targetConnections.start();
    try {
      const endpoint = {
        nodeId: sourceIdentity.address,
        publicKey: sourceIdentity.publicKey,
        tcp: `127.0.0.1:${(sourceConnections as any).server.port}`,
        height: block.index,
        tipHash: block.hash,
        chainId: devnet.chainId,
        genesisHash,
        version: '1.0.0',
        timestamp: Date.now(),
        lastSeen: Date.now(),
        capabilities: ['full_node'],
        signature: 'ab'.repeat(64)
      };
      targetPeers.set(sourceIdentity.address, endpoint);
      expect(await targetConnections.connectToPeer(endpoint)).toBe(true);
      for (let attempt = 0; attempt < 200 && await target.getHeight() !== 1; attempt++) await Bun.sleep(5);

      expect(await target.getHeight()).toBe(1);
      expect((await target.getLatestBlock())?.hash).toBe(block.hash);

      const transaction = await createSignedTransaction(
        devnet.chainId,
        funded.address,
        generateAddress(devnet.addressPrefix).address,
        devnet.initialReward / 2n,
        0,
        1000n,
        hexToBytes(funded.privateKey)
      );
      await sourceMempool.addTransaction(transaction);
      for (let attempt = 0; attempt < 200 && !targetMempool.hasTransaction(transaction.hash); attempt++) {
        await Bun.sleep(5);
      }
      expect(targetMempool.hasTransaction(transaction.hash)).toBe(true);
    } finally {
      targetRelay.stop();
      sourceRelay.stop();
      await targetSync.stop();
      await sourceSync.stop();
      await targetConnections.stop();
      await sourceConnections.stop();
    }
  });
});
