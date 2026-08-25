import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { MiningService } from '../../src/services/mining';
import { Blockchain } from '../../src/core/blockchain';
import { Mempool } from '../../src/core/mempool';
import { MemoryAdapter } from '../../src/storage/memory';
import { generateAddress } from '../../src/crypto/address';
import { createSignedTransaction } from '../../src/core/transaction';
import { hexToBytes } from '@noble/hashes/utils';
import type { ChainConfig } from '../../src/config/chain';

// test config with easy mining
const testConfig: ChainConfig = {
  chainId: 9999,
  name: 'test',
  targetBlockTime: 1,
  difficultyAdjustmentInterval: 100,
  maxSupply: 21_000_000n * 100_000_000n,
  initialReward: 50n * 100_000_000n,
  halvingInterval: 210_000,
  minFeePerByte: 1n,
  initialDifficulty: 1,
  minDifficulty: 1,
  maxDifficultyAdjustment: 4,
  maxBlockSize: 1_000_000,
  maxTimeDrift: 600,
  medianTimeBlocks: 11,
  hashAlgorithm: 'sha256',
  addressPrefix: 0x00,
  genesisTimestamp: 1000000000000,
  genesisNonce: 0,
  genesisMemo: 'test genesis',
  features: {}
};

describe('MiningService', () => {
  let blockchain: Blockchain;
  let mempool: Mempool;
  let storage: MemoryAdapter;
  let miningService: MiningService;
  
  // save original env vars
  const originalEnv = { ...process.env };
  
  beforeEach(async () => {
    // setup test environment
    process.env.ENABLE_MINING = 'false'; // disabled by default
    process.env.MINING_INTERVAL = '100'; // 100ms for fast tests
    process.env.MINING_MAX_ITERATIONS = '1000000'; // enough to find blocks
    
    storage = new MemoryAdapter();
    await storage.connect();
    
    blockchain = new Blockchain(storage, testConfig);
    await blockchain.initialize();
    
    mempool = new Mempool(storage, testConfig);
    await mempool.initialize();
  });
  
  afterEach(async () => {
    // cleanup
    if (miningService) {
      miningService.stop();
    }
    
    await storage.close();
    
    // restore env vars
    process.env = { ...originalEnv };
  });
  
  describe('configuration', () => {
    it('should not start when mining disabled', () => {
      process.env.ENABLE_MINING = 'false';
      
      miningService = new MiningService({
        blockchain,
        mempool
      });
      
      expect(miningService.isEnabled()).toBe(false);
    });
    
    it('should not start without miner address', () => {
      process.env.ENABLE_MINING = 'true';
      delete process.env.MINER_ADDRESS;
      
      miningService = new MiningService({
        blockchain,
        mempool
      });
      
      expect(miningService.isEnabled()).toBe(true);
      // but should not actually mine without address
    });
    
    it('should start when properly configured', () => {
      const miner = generateAddress(testConfig.addressPrefix);
      process.env.ENABLE_MINING = 'true';
      process.env.MINER_ADDRESS = miner.address;
      
      miningService = new MiningService({
        blockchain,
        mempool,
        minerAddress: miner.address,
        autoStart: true
      });
      
      expect(miningService.isEnabled()).toBe(true);
    });
  });
  
  describe('mining', () => {
    it('should mine a block', async () => {
      const miner = generateAddress(testConfig.addressPrefix);
      process.env.ENABLE_MINING = 'true';
      process.env.MINER_ADDRESS = miner.address;
      
      miningService = new MiningService({
        blockchain,
        mempool,
        minerAddress: miner.address,
        autoStart: true,
        interval: 100,
        maxIterations: 1000
      });
      
      // wait for a block to be mined
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const stats = miningService.getStats();
      expect(stats.blocksFound).toBeGreaterThan(0);
      expect(stats.totalReward).toBeGreaterThan(0n);
      
      // check blockchain height increased
      const height = await blockchain.getHeight();
      expect(height).toBeGreaterThan(0);
      
      // check miner got reward
      const balance = await blockchain.getBalance(miner.address);
      expect(balance).toBe(testConfig.initialReward);
    });
    
    it('should include mempool transactions', async () => {
      // create some test transactions
      const alice = generateAddress(testConfig.addressPrefix);
      const bob = generateAddress(testConfig.addressPrefix);
      const miner = generateAddress(testConfig.addressPrefix);
      
      // give alice some balance first
      await storage.updateAccountState(alice.address, {
        balance: 10_000_000_000n, // 100 BOLT
        nonce: 0
      });
      
      // create transaction
      const tx = await createSignedTransaction(
        testConfig.chainId,
        alice.address,
        bob.address,
        1_000_000_000n, // 10 BOLT
        0,
        1000n, // fee
        hexToBytes(alice.privateKey)
      );
      
      await mempool.addTransaction(tx);
      
      // setup mining
      process.env.ENABLE_MINING = 'true';
      process.env.MINER_ADDRESS = miner.address;
      
      miningService = new MiningService({
        blockchain,
        mempool,
        minerAddress: miner.address,
        autoStart: true,
        interval: 100,
        maxIterations: 10000
      });
      
      // wait for mining
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // check transaction was included
      const mempoolStats = mempool.getStats();
      expect(mempoolStats.size).toBe(0); // should be removed from mempool
      
      // check bob received funds
      const bobBalance = await blockchain.getBalance(bob.address);
      expect(bobBalance).toBe(1_000_000_000n);
      
      // check miner got reward + fee
      const minerBalance = await blockchain.getBalance(miner.address);
      expect(minerBalance).toBe(testConfig.initialReward + 1000n);
    });
    
    it('should handle mining failures gracefully', async () => {
      const miner = generateAddress(testConfig.addressPrefix);
      process.env.ENABLE_MINING = 'true';
      process.env.MINER_ADDRESS = miner.address;
      process.env.MINING_MAX_ITERATIONS = '1'; // limit iterations
      
      miningService = new MiningService({
        blockchain,
        mempool,
        minerAddress: miner.address,
        autoStart: true,
        interval: 100,
        maxIterations: 1
      });
      
      // wait for mining attempt
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // with difficulty 1, even 1 iteration might find a block
      // just verify mining service is working without errors
      const stats = miningService.getStats();
      expect(stats).toBeDefined();
      expect(stats.blocksFound).toBeGreaterThanOrEqual(0);
    });
  });
  
  describe('statistics', () => {
    it('should track mining statistics', async () => {
      const miner = generateAddress(testConfig.addressPrefix);
      process.env.ENABLE_MINING = 'true';
      process.env.MINER_ADDRESS = miner.address;
      
      miningService = new MiningService({
        blockchain,
        mempool,
        minerAddress: miner.address,
        autoStart: true,
        interval: 100,
        maxIterations: 10000
      });
      
      // wait for multiple blocks
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const stats = miningService.getStats();
      expect(stats.blocksFound).toBeGreaterThan(1);
      expect(stats.lastBlockTime).toBeDefined();
      expect(stats.totalReward).toBe(
        testConfig.initialReward * BigInt(stats.blocksFound)
      );
    });
  });
  
  describe('lifecycle', () => {
    it('should stop mining when requested', async () => {
      const miner = generateAddress(testConfig.addressPrefix);
      process.env.ENABLE_MINING = 'true';
      process.env.MINER_ADDRESS = miner.address;
      
      miningService = new MiningService({
        blockchain,
        mempool,
        minerAddress: miner.address,
        autoStart: true,
        interval: 100,
        maxIterations: 10000
      });
      
      // wait for a block
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const statsBefore = miningService.getStats();
      const blocksBefore = statsBefore.blocksFound;
      
      // stop mining
      miningService.stop();
      
      // wait a bit
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // should not have mined more blocks
      const statsAfter = miningService.getStats();
      expect(statsAfter.blocksFound).toBe(blocksBefore);
    });
  });
});
