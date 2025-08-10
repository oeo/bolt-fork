import { describe, test, expect, beforeEach } from 'bun:test';
import { ForkManager } from '../../src/core/fork-manager';
import { BlockClass } from '../../src/core/block';
import { Blockchain } from '../../src/core/blockchain';
import { MemoryAdapter } from '../../src/storage/memory';
import { testnet } from '../../src/config/chains/testnet';
import { calculateChainVersionHash } from '../../src/config/chain';
import { createCoinbaseTransaction } from '../../src/core/transaction';
import { generateAddress } from '../../src/crypto/address';

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
        chainVersionHash: 'chain1',
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
        chainVersionHash: 'chain1',
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
        chainVersionHash: 'chain1',
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
        chainVersionHash: 'chain1',
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
        chainVersionHash: 'chain1',
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
        chainVersionHash: 'chain1',
        transactions: []
      };
      
      forkManager.addFork(block1, 100n, 'peer1');
      const updatedFork = forkManager.updateFork('hash1', block2, 'peer1');
      
      expect(updatedFork).toBeDefined();
      expect(updatedFork?.tipHeight).toBe(11);
      expect(updatedFork?.cumulativeDifficulty).toBe(115n); // 100 + 15
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
            chainVersionHash: 'chain1',
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
            chainVersionHash: 'chain1',
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
    let chainVersionHash: string;
    let miner1Address: string;
    let miner2Address: string;
    
    beforeEach(async () => {
      storage = new MemoryAdapter();
      await storage.connect();
      blockchain = new Blockchain(storage, testnet);
      await blockchain.initialize();
      chainVersionHash = calculateChainVersionHash(testnet);
      
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
      const coinbase1 = createCoinbaseTransaction(miner1Address, testnet.initialReward, 0n);
      const block1 = new BlockClass(
        1,
        Date.now(),
        genesis!.hash,
        [coinbase1],
        testnet.initialDifficulty,
        chainVersionHash,
        'miner1'
      );
      block1.mine();
      
      // add first block
      const result1 = await blockchain.addBlock(block1);
      if (!result1.valid) {
        console.log('Block add failed:', result1.error);
      }
      expect(result1.valid).toBe(true);
      
      // create competing block at same height
      const coinbase2 = createCoinbaseTransaction(miner2Address, testnet.initialReward, 0n);
      const competingBlock = new BlockClass(
        1,
        Date.now(),
        genesis!.hash,
        [coinbase2],
        testnet.initialDifficulty,
        chainVersionHash,
        'miner2'
      );
      competingBlock.mine();
      
      // try to add competing block
      const result = await blockchain.handleCompetingBlock(competingBlock);
      
      // should reject because it has same difficulty but we saw ours first
      expect(result.valid).toBe(false);
      expect(result.error).toContain('less work');
    });
    
    test('should handle fork with more blocks', async () => {
      // get genesis
      const genesis = await blockchain.getBlock(0);
      expect(genesis).toBeDefined();
      
      // create first block on our chain
      const coinbase1 = createCoinbaseTransaction(miner1Address, testnet.initialReward, 0n);
      const block1 = new BlockClass(
        1,
        Date.now(),
        genesis!.hash,
        [coinbase1],
        testnet.initialDifficulty,
        chainVersionHash,
        'miner1'
      );
      block1.mine();
      
      // add first block
      const result1 = await blockchain.addBlock(block1);
      if (!result1.valid) {
        console.log('Block add failed:', result1.error);
      }
      expect(result1.valid).toBe(true);
      
      // create competing fork with TWO blocks (more cumulative work)
      const coinbase2a = createCoinbaseTransaction(miner2Address, testnet.initialReward, 0n);
      const competingBlock1 = new BlockClass(
        1,
        Date.now() + 1000,
        genesis!.hash,
        [coinbase2a],
        testnet.initialDifficulty,
        chainVersionHash,
        'miner2'
      );
      competingBlock1.mine();
      
      // second block on competing fork
      const coinbase2b = createCoinbaseTransaction(miner2Address, testnet.initialReward, 0n);
      const competingBlock2 = new BlockClass(
        2,
        Date.now() + 2000,
        competingBlock1.hash,
        [coinbase2b],
        testnet.initialDifficulty,
        chainVersionHash,
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
      const coinbase = createCoinbaseTransaction(miner1Address, testnet.initialReward, 0n);
      const orphanBlock = new BlockClass(
        10,
        Date.now(),
        'unknown_hash',
        [coinbase],
        testnet.initialDifficulty,
        chainVersionHash,
        'miner1'
      );
      orphanBlock.mine();
      
      const result = await blockchain.handleCompetingBlock(orphanBlock);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Orphan block');
    });
  });
  
  describe('cumulative difficulty tracking', () => {
    let blockchain: Blockchain;
    let storage: MemoryAdapter;
    let chainVersionHash: string;
    let miner1Address: string;
    let miner2Address: string;
    
    beforeEach(async () => {
      storage = new MemoryAdapter();
      await storage.connect();
      blockchain = new Blockchain(storage, testnet);
      await blockchain.initialize();
      chainVersionHash = calculateChainVersionHash(testnet);
      
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
      const coinbase1 = createCoinbaseTransaction(miner1Address, testnet.initialReward, 0n);
      const block1 = new BlockClass(
        1,
        Date.now(),
        genesis!.hash,
        [coinbase1],
        testnet.initialDifficulty,
        chainVersionHash,
        'miner1'
      );
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
      const coinbase2 = createCoinbaseTransaction(miner2Address, testnet.initialReward, 0n);
      const block2 = new BlockClass(
        2,
        Date.now() + 1000, // ensure timestamp is after block1
        block1.hash,
        [coinbase2],
        testnet.initialDifficulty,
        chainVersionHash,
        'miner2'
      );
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
});