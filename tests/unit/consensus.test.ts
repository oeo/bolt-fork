import { describe, test, expect, beforeEach } from 'bun:test';
import { ForkManager } from '../../src/core/fork-manager';
import { BlockClass } from '../../src/core/block';
import { Blockchain } from '../../src/core/blockchain';
import { Mempool } from '../../src/core/mempool';
import { MemoryAdapter } from '../../src/storage/memory';
import { testnet as testnetConfig } from '../../src/config/chains/testnet';
import { createCoinbaseTransaction, createSignedTransaction } from '../../src/core/transaction';
import { generateAddress } from '../../src/crypto/address';
import { hexToBytes } from '@noble/hashes/utils';

const testnet = { ...testnetConfig, initialDifficulty: 1 };

describe('consensus mechanism', () => {
  
  describe('fork manager', () => {
    let forkManager: ForkManager;
    
    beforeEach(() => {
      forkManager = new ForkManager();
    });
    
    test('should track competing forks', () => {
      const block1 = {
        index: 10,
        hash: 'hash1',
        previousHash: 'prev1',
        timestamp: Date.now(),
        difficulty: 10,
        nonce: 0,
        merkleRoot: 'merkle1',
        transactions: []
      };
      
      forkManager.addFork(block1, 1000n, 'peer1');
      const stats = forkManager.getStats();
      
      expect(stats.forksCount).toBe(1);
      expect(stats.bestForkHeight).toBe(10);
      expect(stats.bestForkDifficulty).toBe('1000');
    });
    
    test('should identify best fork by cumulative difficulty', () => {
      const fork1 = {
        index: 10,
        hash: 'hash1',
        previousHash: 'prev1',
        timestamp: Date.now(),
        difficulty: 10,
        nonce: 0,
        merkleRoot: 'merkle1',
        transactions: []
      };
      
      const fork2 = {
        index: 9,
        hash: 'hash2',
        previousHash: 'prev2',
        timestamp: Date.now(),
        difficulty: 20,
        nonce: 0,
        merkleRoot: 'merkle2',
        transactions: []
      };
      
      forkManager.addFork(fork1, 1000n, 'peer1');
      forkManager.addFork(fork2, 1500n, 'peer2'); // higher cumulative difficulty
      
      const bestFork = forkManager.getBestFork();
      expect(bestFork).toBeDefined();
      expect(bestFork?.tipHash).toBe('hash2');
      expect(bestFork?.cumulativeDifficulty).toBe(1500n);
    });
    
    test('should handle orphan blocks', () => {
      const orphan = {
        index: 15,
        hash: 'orphan1',
        previousHash: 'unknown',
        timestamp: Date.now(),
        difficulty: 10,
        nonce: 0,
        merkleRoot: 'merkle',
        transactions: []
      };
      
      forkManager.addOrphan(orphan);
      const stats = forkManager.getStats();
      
      expect(stats.orphansCount).toBe(1);
      
      // getOrphansExtending looks for orphans that have the given hash as previousHash
      // the orphan we added has 'unknown' as previousHash, not as its hash
      const orphansWithUnknownParent = forkManager.getOrphansExtending('unknown');
      expect(orphansWithUnknownParent.length).toBe(1); // found orphan with 'unknown' as previousHash
      
      const orphansExtending = forkManager.getOrphansExtending('orphan1');
      expect(orphansExtending.length).toBe(0); // no orphans have 'orphan1' as previousHash
    });
    
    test('should update existing fork with new blocks', () => {
      const block1 = {
        index: 10,
        hash: 'hash1',
        previousHash: 'prev1',
        timestamp: Date.now(),
        difficulty: 10,
        nonce: 0,
        merkleRoot: 'merkle1',
        transactions: []
      };
      
      const block2 = {
        index: 11,
        hash: 'hash2',
        previousHash: 'hash1',
        timestamp: Date.now(),
        difficulty: 15,
        nonce: 0,
        merkleRoot: 'merkle2',
        transactions: []
      };
      
      forkManager.addFork(block1, 100n, 'peer1');
      const updatedFork = forkManager.updateFork('hash1', block2, 'peer1');
      
      expect(updatedFork).toBeDefined();
      expect(updatedFork?.tipHeight).toBe(11);
      expect(updatedFork?.cumulativeDifficulty).toBe(114n);
      expect(updatedFork?.blocks.length).toBe(2);
    });
    
    test('should compare forks correctly', () => {
      const fork = {
        tipHash: 'fork1',
        tipHeight: 12,
        blocks: [
          {
            index: 11,
            hash: 'f1',
            previousHash: 'common',
            timestamp: Date.now(),
            difficulty: 20,
            nonce: 0,
            merkleRoot: 'merkle',
                transactions: []
          },
          {
            index: 12,
            hash: 'fork1',
            previousHash: 'f1',
            timestamp: Date.now(),
            difficulty: 25,
            nonce: 0,
            merkleRoot: 'merkle',
                transactions: []
          }
        ],
        cumulativeDifficulty: 2000n,
        lastSeen: Date.now()
      };
      
      const comparison = forkManager.compareFork(fork, 13, 1800n);
      
      expect(comparison.ourWork).toBe(1800n);
      expect(comparison.theirWork).toBe(2000n);
      expect(comparison.shouldReorganize).toBe(true);
    });
  });
  
  describe('blockchain reorganization', () => {
    let blockchain: Blockchain;
    let storage: MemoryAdapter;
    let miner1Address: string;
    let miner2Address: string;
    
    beforeEach(async () => {
      storage = new MemoryAdapter();
      await storage.connect();
      blockchain = new Blockchain(storage, testnet);
      await blockchain.initialize();
      
      // generate valid addresses for miners
      const miner1Wallet = await generateAddress(testnet.addressPrefix);
      const miner2Wallet = await generateAddress(testnet.addressPrefix);
      miner1Address = miner1Wallet.address;
      miner2Address = miner2Wallet.address;
    });
    
    test('should detect competing blocks', async () => {
      // get genesis block
      const genesis = await blockchain.getLatestBlock();
      expect(genesis).toBeDefined();
      
      // create first block
      const timestamp1 = Date.now();
      const coinbase1 = createCoinbaseTransaction(testnet.chainId, miner1Address, testnet.initialReward, 0n, timestamp1);
      const block1 = new BlockClass(
        1,
        timestamp1,
        genesis!.hash,
        [coinbase1],
        testnet.initialDifficulty,
        'miner1'
      );
      await blockchain.prepareBlock(block1);
      block1.mine();
      
      // add first block
      const result1 = await blockchain.addBlock(block1);
      if (!result1.valid) {
        console.log('Block add failed:', result1.error);
      }
      expect(result1.valid).toBe(true);
      
      // create competing block at same height
      const timestamp2 = Date.now();
      const coinbase2 = createCoinbaseTransaction(testnet.chainId, miner2Address, testnet.initialReward, 0n, timestamp2);
      const competingBlock = new BlockClass(
        1,
        timestamp2,
        genesis!.hash,
        [coinbase2],
        testnet.initialDifficulty,
        'miner2'
      );
      await blockchain.prepareBlock(competingBlock);
      competingBlock.mine();
      
      // try to add competing block
      const result = await blockchain.handleCompetingBlock(competingBlock);
      
      // should reject because it has same difficulty but we saw ours first
      expect(result.valid).toBe(false);
      expect(result.error).toContain('less work');
    });

    test('should serialize competing block acceptance', async () => {
      const genesis = await blockchain.getLatestBlock();
      const blocks = await Promise.all([miner1Address, miner2Address].map(async (address, index) => {
        const timestamp = Date.now() + index;
        const coinbase = createCoinbaseTransaction(
          testnet.chainId,
          address,
          testnet.initialReward,
          0n,
          timestamp
        );
        const block = new BlockClass(
          1,
          timestamp,
          genesis!.hash,
          [coinbase],
          testnet.initialDifficulty
        );
        await blockchain.prepareBlock(block);
        block.mine();
        return block;
      }));
      let committedEvents = 0;
      blockchain.on('block:added', () => committedEvents++);

      const results = await Promise.all(blocks.map(block => blockchain.addBlock(block)));

      expect(results.filter(result => result.valid)).toHaveLength(1);
      expect(await blockchain.getHeight()).toBe(1);
      expect(committedEvents).toBe(1);
      expect(
        await blockchain.getBalance(miner1Address) + await blockchain.getBalance(miner2Address)
      ).toBe(testnet.initialReward);
    });
    
    test('should handle fork with more blocks', async () => {
      // get genesis
      const genesis = await blockchain.getBlock(0);
      expect(genesis).toBeDefined();
      
      // create first block on our chain
      const timestamp1 = Date.now();
      const coinbase1 = createCoinbaseTransaction(testnet.chainId, miner1Address, testnet.initialReward, 0n, timestamp1);
      const block1 = new BlockClass(
        1,
        timestamp1,
        genesis!.hash,
        [coinbase1],
        testnet.initialDifficulty,
        'miner1'
      );
      await blockchain.prepareBlock(block1);
      block1.mine();
      
      // add first block
      const result1 = await blockchain.addBlock(block1);
      if (!result1.valid) {
        console.log('Block add failed:', result1.error);
      }
      expect(result1.valid).toBe(true);
      
      // create competing fork with TWO blocks (more cumulative work)
      const timestamp2a = Date.now() + 1000;
      const coinbase2a = createCoinbaseTransaction(testnet.chainId, miner2Address, testnet.initialReward, 0n, timestamp2a);
      const competingBlock1 = new BlockClass(
        1,
        timestamp2a,
        genesis!.hash,
        [coinbase2a],
        testnet.initialDifficulty,
        'miner2'
      );
      await blockchain.prepareBlock(competingBlock1);
      competingBlock1.mine();
      
      // second block on competing fork
      const timestamp2b = Date.now() + 2000;
      const coinbase2b = createCoinbaseTransaction(testnet.chainId, miner2Address, testnet.initialReward, 0n, timestamp2b);
      const competingBlock2 = new BlockClass(
        2,
        timestamp2b,
        competingBlock1.hash,
        [coinbase2b],
        testnet.initialDifficulty,
        'miner2'
      );
      competingBlock2.mine();
      
      // handle the first competing block
      const result = await blockchain.handleCompetingBlock(competingBlock1);
      
      // it should create a fork but not reorganize yet (equal work)
      expect(result.valid).toBe(false);
      expect(result.error).toContain('less work');
      
      // TODO: when we handle the second block, it would trigger reorganization
      // but that requires more complete fork chain tracking
    });
    
    test('should handle orphan blocks', async () => {
      // create orphan block (unknown parent)
      const timestamp = Date.now();
      const coinbase = createCoinbaseTransaction(testnet.chainId, miner1Address, testnet.initialReward, 0n, timestamp);
      const orphanBlock = new BlockClass(
        10,
        timestamp,
        'unknown_hash',
        [coinbase],
        testnet.initialDifficulty,
        'miner1'
      );
      await blockchain.prepareBlock(orphanBlock);
      orphanBlock.mine();
      
      const result = await blockchain.handleCompetingBlock(orphanBlock);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Orphan block');
    });
  });
  
  describe('cumulative difficulty tracking', () => {
    let blockchain: Blockchain;
    let storage: MemoryAdapter;
    let miner1Address: string;
    let miner2Address: string;
    
    beforeEach(async () => {
      storage = new MemoryAdapter();
      await storage.connect();
      blockchain = new Blockchain(storage, testnet);
      await blockchain.initialize();
      
      // generate valid addresses for miners
      const miner1Wallet = await generateAddress(testnet.addressPrefix);
      const miner2Wallet = await generateAddress(testnet.addressPrefix);
      miner1Address = miner1Wallet.address;
      miner2Address = miner2Wallet.address;
    });
    
    test('should track cumulative difficulty correctly', async () => {
      // initial cumulative difficulty (genesis)
      let cumulative = await blockchain.getCumulativeDifficulty();
      expect(cumulative).toBe(BigInt(testnet.initialDifficulty));
      
      // get genesis
      const genesis = await blockchain.getLatestBlock();
      
      // add a block
      const timestamp1 = Date.now();
      const coinbase1 = createCoinbaseTransaction(testnet.chainId, miner1Address, testnet.initialReward, 0n, timestamp1);
      const block1 = new BlockClass(
        1,
        timestamp1,
        genesis!.hash,
        [coinbase1],
        testnet.initialDifficulty,
        'miner1'
      );
      await blockchain.prepareBlock(block1);
      block1.mine();
      
      const result1 = await blockchain.addBlock(block1);
      if (!result1.valid) {
        console.log('Block add failed (cumulative test):', result1.error);
      }
      expect(result1.valid).toBe(true);
      
      // cumulative should increase
      cumulative = await blockchain.getCumulativeDifficulty();
      expect(cumulative).toBe(BigInt(testnet.initialDifficulty * 2));
      
      // add another block
      const timestamp2 = Date.now() + 1000;
      const coinbase2 = createCoinbaseTransaction(testnet.chainId, miner2Address, testnet.initialReward, 0n, timestamp2);
      const block2 = new BlockClass(
        2,
        timestamp2,
        block1.hash,
        [coinbase2],
        testnet.initialDifficulty,
        'miner2'
      );
      await blockchain.prepareBlock(block2);
      block2.mine();
      
      const result2 = await blockchain.addBlock(block2);
      if (!result2.valid) {
        console.log('Block 2 add failed:', result2.error);
      }
      expect(result2.valid).toBe(true);
      
      cumulative = await blockchain.getCumulativeDifficulty();
      expect(cumulative).toBe(BigInt(testnet.initialDifficulty * 3));
    });
    
    test('should use cumulative difficulty for chain selection', async () => {
      const currentCumulative = await blockchain.getCumulativeDifficulty();
      
      // test chain with less work
      const lessWork = await blockchain.selectBestChain([], currentCumulative - 1n);
      expect(lessWork).toBe(false);
      
      // test chain with more work
      const moreWork = await blockchain.selectBestChain([], currentCumulative + 1n);
      expect(moreWork).toBe(true);
      
      // test chain with equal work
      const equalWork = await blockchain.selectBestChain([], currentCumulative);
      expect(equalWork).toBe(false); // keep current when equal
    });
  });
  
  describe('median time validation during reorganization', () => {
    let blockchain: Blockchain;
    let storage: MemoryAdapter;
    const miner1Address = generateAddress(testnet.addressPrefix).address;
    const miner2Address = generateAddress(testnet.addressPrefix).address;
    
    beforeEach(async () => {
      storage = new MemoryAdapter();
      await storage.connect();
      blockchain = new Blockchain(storage, testnet);
      await blockchain.initialize();
    });
    
    test('should validate median time during chain reorganization', async () => {
      // build a chain of 5 blocks
      const genesis = await blockchain.getBlock(0);
      expect(genesis).toBeDefined();
      
      let previousHash = genesis!.hash;
      const baseTimestamp = Date.now();
      
      // create main chain blocks with proper timestamps
      for (let i = 1; i <= 5; i++) {
        const timestamp = baseTimestamp + i * 1000;
        const coinbase = createCoinbaseTransaction(testnet.chainId, miner1Address, testnet.initialReward, 0n, timestamp);
        const block = new BlockClass(
          i,
          timestamp,
          previousHash,
          [coinbase],
          testnet.initialDifficulty,
            'miner1'
        );
        await blockchain.prepareBlock(block);
        block.mine();
        
        const result = await blockchain.addBlock(block);
        if (!result.valid) {
          console.log(`Block ${i} validation failed:`, result.error);
        }
        expect(result.valid).toBe(true);
        previousHash = block.hash;
      }
      
      // create competing fork from block 3 with 3 blocks (total height 6)
      const block3 = await blockchain.getBlock(3);
      const displacedBlock = await blockchain.getBlock(4);
      expect(block3).toBeDefined();
      
      const forkBlocks: BlockClass[] = [];
      previousHash = block3!.hash;
      let forkStates = new Map([
        [miner1Address, { balance: testnet.initialReward * 3n, nonce: 0 }]
      ]);
      
      // create fork blocks with valid median time
      for (let i = 4; i <= 6; i++) {
        const timestamp = baseTimestamp + i * 1100;
        const coinbase = createCoinbaseTransaction(testnet.chainId, miner2Address, testnet.initialReward, 0n, timestamp);
        const block = new BlockClass(
          i,
          timestamp,
          previousHash,
          [coinbase],
          testnet.initialDifficulty,
            'miner2'
        );
        forkStates = await blockchain.prepareBlock(block, forkStates);
        block.mine();
        forkBlocks.push(block);
        previousHash = block.hash;
      }
      
      // trigger reorganization with the fork
      const reorgResult = await blockchain.reorganize(3, forkBlocks.map(b => b.toObject()));
      
      // reorganization should succeed with valid median times
      expect(reorgResult).toBe(true);
      
      // verify the chain now has height 6
      const currentHeight = await blockchain.getHeight();
      expect(currentHeight).toBe(6);
      
      // verify the tip is from the fork
      const tip = await blockchain.getLatestBlock();
      expect(tip?.hash).toBe(forkBlocks[2].hash);
      expect(await storage.getBlockByHash(displacedBlock!.hash)).toBeNull();
      expect(await blockchain.getBalance(miner1Address)).toBe(testnet.initialReward * 3n);
      expect(await blockchain.getBalance(miner2Address)).toBe(testnet.initialReward * 3n);
      expect(await blockchain.getCumulativeDifficulty()).toBe(7n);
    });

    test('should resurrect valid detached transactions atomically', async () => {
      const sender = generateAddress(testnet.addressPrefix);
      const recipient = generateAddress(testnet.addressPrefix);
      const mempool = new Mempool(storage, {
        chainId: testnet.chainId,
        addressPrefix: testnet.addressPrefix,
        minFeePerByte: 1n,
      });
      await mempool.initialize();
      const genesis = await blockchain.getBlock(0);
      const baseTimestamp = Date.now();
      const reward = testnet.initialReward;

      const block1 = new BlockClass(
        1,
        baseTimestamp + 1000,
        genesis!.hash,
        [createCoinbaseTransaction(testnet.chainId, sender.address, reward, 0n, baseTimestamp + 1000)],
        1,
        sender.address
      );
      await blockchain.prepareBlock(block1);
      block1.mine();
      expect((await blockchain.addBlock(block1)).valid).toBe(true);

      const transfer = await createSignedTransaction(
        testnet.chainId,
        sender.address,
        recipient.address,
        reward / 2n,
        0,
        1000n,
        hexToBytes(sender.privateKey),
        baseTimestamp + 1500
      );
      await mempool.addTransaction(transfer);
      const block2 = new BlockClass(
        2,
        baseTimestamp + 2000,
        block1.hash,
        [
          createCoinbaseTransaction(testnet.chainId, miner1Address, reward, transfer.fee, baseTimestamp + 2000),
          transfer,
        ],
        1,
        miner1Address
      );
      await blockchain.prepareBlock(block2);
      block2.mine();
      expect((await blockchain.addBlock(block2)).valid).toBe(true);
      expect(mempool.hasTransaction(transfer.hash)).toBe(false);

      const forkBlocks: BlockClass[] = [];
      let previousHash = block1.hash;
      let forkStates = new Map([[sender.address, { balance: reward, nonce: 0 }]]);
      for (let height = 2; height <= 3; height++) {
        const timestamp = baseTimestamp + height * 1100;
        const block = new BlockClass(
          height,
          timestamp,
          previousHash,
          [createCoinbaseTransaction(testnet.chainId, miner2Address, reward, 0n, timestamp)],
          1,
          miner2Address
        );
        forkStates = await blockchain.prepareBlock(block, forkStates);
        block.mine();
        forkBlocks.push(block);
        previousHash = block.hash;
      }

      expect(await blockchain.reorganize(1, forkBlocks.map(block => block.toObject()))).toBe(true);
      expect(mempool.hasTransaction(transfer.hash)).toBe(true);
      expect(await storage.isInMempool(transfer.hash)).toBe(true);
      expect(await storage.getTransaction(transfer.hash)).toBeNull();
    });

    test('should serialize admission with conflicting block confirmation', async () => {
      const sender = generateAddress(testnet.addressPrefix);
      const firstRecipient = generateAddress(testnet.addressPrefix);
      const secondRecipient = generateAddress(testnet.addressPrefix);
      const mempool = new Mempool(storage, { minFeePerByte: 1n });
      await mempool.initialize();
      const genesis = await blockchain.getBlock(0);
      const baseTimestamp = Date.now();
      const reward = testnet.initialReward;
      const funding = new BlockClass(
        1,
        baseTimestamp + 1000,
        genesis!.hash,
        [createCoinbaseTransaction(testnet.chainId, sender.address, reward, 0n, baseTimestamp + 1000)],
        1,
        sender.address
      );
      await blockchain.prepareBlock(funding);
      funding.mine();
      expect((await blockchain.addBlock(funding)).valid).toBe(true);

      const pending = await createSignedTransaction(
        testnet.chainId,
        sender.address,
        firstRecipient.address,
        reward / 4n,
        0,
        1000n,
        hexToBytes(sender.privateKey),
        baseTimestamp + 1500
      );
      const confirmed = await createSignedTransaction(
        testnet.chainId,
        sender.address,
        secondRecipient.address,
        reward / 4n,
        0,
        1000n,
        hexToBytes(sender.privateKey),
        baseTimestamp + 1600
      );
      const block = new BlockClass(
        2,
        baseTimestamp + 2000,
        funding.hash,
        [
          createCoinbaseTransaction(testnet.chainId, miner1Address, reward, confirmed.fee, baseTimestamp + 2000),
          confirmed,
        ],
        1,
        miner1Address
      );
      await blockchain.prepareBlock(block);
      block.mine();

      const updateMempool = storage.updateMempool.bind(storage);
      let releasePersistence!: () => void;
      let persistenceStarted!: () => void;
      const persistenceGate = new Promise<void>(resolve => {
        releasePersistence = resolve;
      });
      const started = new Promise<void>(resolve => {
        persistenceStarted = resolve;
      });
      storage.updateMempool = async update => {
        persistenceStarted();
        await persistenceGate;
        return updateMempool(update);
      };

      const admission = mempool.addTransaction(pending);
      await started;
      const confirmation = blockchain.addBlock(block);
      releasePersistence();
      await admission;
      expect((await confirmation).valid).toBe(true);
      expect(mempool.hasTransaction(pending.hash)).toBe(false);
      expect(await storage.isInMempool(pending.hash)).toBe(false);
      expect(await storage.getTransaction(confirmed.hash)).toEqual(confirmed.toObject());
    });
    
    test('should reject reorganization with invalid median time', async () => {
      // build a chain of 5 blocks
      const genesis = await blockchain.getBlock(0);
      expect(genesis).toBeDefined();
      
      let previousHash = genesis!.hash;
      const baseTimestamp = Date.now();
      
      // create main chain blocks
      for (let i = 1; i <= 5; i++) {
        const timestamp = baseTimestamp + i * 1000;
        const coinbase = createCoinbaseTransaction(testnet.chainId, miner1Address, testnet.initialReward, 0n, timestamp);
        const block = new BlockClass(
          i,
          timestamp,
          previousHash,
          [coinbase],
          testnet.initialDifficulty,
            'miner1'
        );
        await blockchain.prepareBlock(block);
        block.mine();
        
        const result = await blockchain.addBlock(block);
        if (!result.valid) {
          console.log(`Block ${i} validation failed:`, result.error);
        }
        expect(result.valid).toBe(true);
        previousHash = block.hash;
      }
      
      // create competing fork with invalid median time
      const block3 = await blockchain.getBlock(3);
      expect(block3).toBeDefined();
      
      const forkBlocks: BlockClass[] = [];
      previousHash = block3!.hash;
      let forkStates = new Map([
        [miner1Address, { balance: testnet.initialReward * 3n, nonce: 0 }]
      ]);
      
      // create first fork block with valid time
      const forkTimestamp1 = baseTimestamp + 4100;
      const coinbase1 = createCoinbaseTransaction(testnet.chainId, miner2Address, testnet.initialReward, 0n, forkTimestamp1);
      const forkBlock1 = new BlockClass(
        4,
        forkTimestamp1,
        previousHash,
        [coinbase1],
        testnet.initialDifficulty,
        'miner2'
      );
      forkStates = await blockchain.prepareBlock(forkBlock1, forkStates);
      forkBlock1.mine();
      forkBlocks.push(forkBlock1);
      
      // create second fork block with timestamp that violates median time
      const forkTimestamp2 = baseTimestamp - 10000;
      const coinbase2 = createCoinbaseTransaction(testnet.chainId, miner2Address, testnet.initialReward, 0n, forkTimestamp2);
      const forkBlock2 = new BlockClass(
        5,
        forkTimestamp2,
        forkBlock1.hash,
        [coinbase2],
        testnet.initialDifficulty,
        'miner2'
      );
      await blockchain.prepareBlock(forkBlock2, forkStates);
      forkBlock2.mine();
      forkBlocks.push(forkBlock2);
      
      // attempt reorganization with invalid median time
      const reorgResult = await blockchain.reorganize(3, forkBlocks.map(b => b.toObject()));
      
      // reorganization should fail due to median time violation
      expect(reorgResult).toBe(false);
      
      // verify the chain height hasn't changed
      const currentHeight = await blockchain.getHeight();
      expect(currentHeight).toBe(5);
      
      // verify the tip is still from the original chain
      const tip = await blockchain.getLatestBlock();
      expect(tip?.miner).toBe('miner1');
    });
  });
});
