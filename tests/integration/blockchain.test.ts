import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Blockchain } from '../../src/core/blockchain';
import { BlockClass } from '../../src/core/block';
import { TransactionClass, createSignedTransaction } from '../../src/core/transaction';
import { MemoryAdapter } from '../../src/storage/memory';
import { ChainConfig } from '../../src/config/chain';
import { generateAddress } from '../../src/crypto/address';
import { hexToBytes } from '@noble/hashes/utils';

// test configuration
const testConfig: ChainConfig = {
  chainId: 9999,
  name: 'test',
  targetBlockTime: 1,
  difficultyAdjustmentInterval: 10,
  maxSupply: 21000000n * 100000000n,
  initialReward: 50n * 100000000n,
  halvingInterval: 100,
  minFeePerByte: 1n,
  initialDifficulty: 1,
  minDifficulty: 1,
  maxDifficultyAdjustment: 4,
  maxBlockSize: 1000000,
  maxTimeDrift: 600,
  medianTimeBlocks: 11,
  hashAlgorithm: 'sha256',
  addressPrefix: 0x00,
  genesisTimestamp: 1000000000000,
  genesisNonce: 0,
  genesisMemo: 'test genesis',
  features: {}
};

// calculate chain version hash for test config

describe('Blockchain Integration', () => {
  let blockchain: Blockchain;
  let storage: MemoryAdapter;
  
  beforeEach(async () => {
    storage = new MemoryAdapter();
    blockchain = new Blockchain(storage, testConfig, 'sha256');
    await blockchain.initialize();
  });
  
  afterEach(async () => {
    await blockchain.close();
  });
  
  describe('address generation', () => {
    it('should generate valid bolt addresses', () => {
      // generate a few addresses to showcase address format
      const addr1 = generateAddress(testConfig.addressPrefix);
      const addr2 = generateAddress(testConfig.addressPrefix);
      const addr3 = generateAddress(testConfig.addressPrefix);
      
      console.log('Example Bolt addresses:');
      console.log('  Address 1:', addr1.address);
      console.log('  Address 2:', addr2.address);
      console.log('  Address 3:', addr3.address);
      
      // addresses should be base58 encoded
      expect(addr1.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      expect(addr2.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      
      // addresses should be 25-35 characters long typically
      expect(addr1.address.length).toBeGreaterThan(24);
      expect(addr1.address.length).toBeLessThan(36);
      
      // each address should be unique
      expect(addr1.address).not.toBe(addr2.address);
      expect(addr2.address).not.toBe(addr3.address);
      
      // private keys should be 64 hex characters
      expect(addr1.privateKey).toMatch(/^[0-9a-f]{64}$/);
      
      // public keys should be 130 hex characters (uncompressed)
      expect(addr1.publicKey).toMatch(/^[0-9a-f]{130}$/);
    });
  });
  
  describe('initialization', () => {
    it('should create genesis block', async () => {
      const genesis = await blockchain.getBlock(0);
      expect(genesis).toBeTruthy();
      expect(genesis!.index).toBe(0);
      expect(genesis!.previousHash).toBe('0'.repeat(64));
    });
    
    it('should set correct initial height', async () => {
      const height = await blockchain.getHeight();
      expect(height).toBe(0);
    });
    
    it('should prevent double initialization', async () => {
      // second init should not create another genesis
      await blockchain.initialize();
      const height = await blockchain.getHeight();
      expect(height).toBe(0);
      
      const blocks = await storage.getBlockRange(0, 10);
      expect(blocks.length).toBe(1);
    });

    it('should reject obsolete storage versions', async () => {
      expect(await storage.getChainMetadata('storageVersion')).toBe('6');
      await storage.saveChainMetadata('storageVersion', '5');
      const reloaded = new Blockchain(storage, testConfig);
      await expect(reloaded.initialize()).rejects.toThrow('incompatible');
    });

    it('should reject storage from another chain', async () => {
      const reloaded = new Blockchain(storage, { ...testConfig, chainId: testConfig.chainId + 1 });
      await expect(reloaded.initialize()).rejects.toThrow('incompatible');
    });

    it('should reject configurable consensus hashing', () => {
      expect(() => new Blockchain(storage, { ...testConfig, hashAlgorithm: 'scrypt' })).toThrow('sha256');
    });
  });
  
  describe('block addition', () => {
    it('should add valid block', async () => {
      // create a valid block
      const previousBlock = await blockchain.getLatestBlock();
      expect(previousBlock).toBeTruthy();
      
      // generate valid miner address
      const miner = generateAddress(testConfig.addressPrefix);
      const minerAddress = miner.address;
      const block = new BlockClass(
        1,
        Date.now(),
        previousBlock!.hash,
        [],
        1,
        minerAddress
      );
      
      // add coinbase transaction
      const blockReward = blockchain.getBlockReward(1);
      const coinbase = new TransactionClass(
        testConfig.chainId,
        null,
        minerAddress,
        blockReward,
        0,
        0n,
        block.timestamp
      );
      block.transactions = [coinbase.toObject()];
      block.merkleRoot = block.calculateMerkleRoot();
      await blockchain.prepareBlock(block);
      const mineResult = block.mine('sha256', 1000000);
      expect(mineResult.success).toBe(true);
      
      // add to blockchain
      const result = await blockchain.addBlock(block);
      if (!result.valid) {
        console.log('Block validation failed:', result.error);
      }
      expect(result.valid).toBe(true);
      const height = await blockchain.getHeight();
      expect(height).toBe(1);
      
      // verify block was saved
      const savedBlock = await blockchain.getBlock(1);
      expect(savedBlock).toBeTruthy();
      expect(savedBlock!.hash).toBe(block.hash);
    });
    
    it('should reject block with invalid previous hash', async () => {
      const block = new BlockClass(
        1,
        Date.now(),
        'f'.repeat(64),
        [],
        1,
      );
      
      // need to set hash to pass initial validation
      block.hash = block.calculateHash();
      
      const result = await blockchain.addBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid previous hash link');
    });
    
    it('should reject block with wrong difficulty', async () => {
      const previousBlock = await blockchain.getLatestBlock();
      const minerAddress = generateAddress(testConfig.addressPrefix).address;
      const block = new BlockClass(
        1,
        Date.now(),
        previousBlock!.hash,
        [],
        999, // wrong difficulty
      );
      
      // add coinbase transaction and mine block to pass structure validation
      const coinbase = new TransactionClass(
        testConfig.chainId,
        null,
        minerAddress,
        blockchain.getBlockReward(1),
        0,
        0n,
        block.timestamp
      );
      block.transactions = [coinbase.toObject()];
      block.merkleRoot = block.calculateMerkleRoot();
      await blockchain.prepareBlock(block);
      block.mine('sha256', 1000000);
      
      const result = await blockchain.addBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('difficulty');
    });
    
    it('should reject block with invalid coinbase', async () => {
      const previousBlock = await blockchain.getLatestBlock();
      const miner = generateAddress(testConfig.addressPrefix);
      const minerAddress = miner.address;
      
      const block = new BlockClass(
        1,
        Date.now(),
        previousBlock!.hash,
        [],
        1,
        minerAddress
      );
      
      // add coinbase before corrupting amount
      const wrongReward = 1000n * 100000000n; // too much
      const coinbase = new TransactionClass(
        testConfig.chainId,
        null,
        minerAddress,
        blockchain.getBlockReward(1),
        0,
        0n,
        block.timestamp
      );
      block.transactions = [coinbase.toObject()];
      block.merkleRoot = block.calculateMerkleRoot();
      
      // mine the block
      await blockchain.prepareBlock(block);
      block.mine('sha256', 1000000);
      block.transactions[0].amount = wrongReward;
      
      const result = await blockchain.addBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('coinbase');
    });
  });
  
  describe('account operations', () => {
    it('should track account balances', async () => {
      const miner = generateAddress(testConfig.addressPrefix);
      const minerAddress = miner.address;
      
      // mine a block
      const previousBlock = await blockchain.getLatestBlock();
      const block = new BlockClass(
        1,
        Date.now(),
        previousBlock!.hash,
        [],
        1,
        minerAddress
      );
      
      const blockReward = blockchain.getBlockReward(1);
      const coinbase = new TransactionClass(
        testConfig.chainId,
        null,
        minerAddress,
        blockReward,
        0,
        0n,
        block.timestamp
      );
      block.transactions = [coinbase.toObject()];
      block.merkleRoot = block.calculateMerkleRoot();
      await blockchain.prepareBlock(block);
      block.mine('sha256', 1000000);
      
      await blockchain.addBlock(block);
      
      // check balance
      const balance = await blockchain.getBalance(minerAddress);
      expect(balance).toBe(blockReward);
      
      // check nonce
      const nonce = await blockchain.getNonce(minerAddress);
      expect(nonce).toBe(0);
    });
    
    it('should process transactions correctly', async () => {
      // setup wallets
      const miner = generateAddress(testConfig.addressPrefix);
      const alice = generateAddress(testConfig.addressPrefix);
      const bob = generateAddress(testConfig.addressPrefix);
      
      // mine first block to get funds
      const previousBlock = await blockchain.getLatestBlock();
      const block1 = new BlockClass(
        1,
        Date.now(),
        previousBlock!.hash,
        [],
        1,
        miner.address
      );
      
      const blockReward = blockchain.getBlockReward(1);
      const coinbase1 = new TransactionClass(
        testConfig.chainId,
        null,
        miner.address,
        blockReward,
        0,
        0n,
        block1.timestamp
      );
      block1.transactions = [coinbase1.toObject()];
      block1.merkleRoot = block1.calculateMerkleRoot();
      await blockchain.prepareBlock(block1);
      block1.mine('sha256', 1000000);
      
      const result1 = await blockchain.addBlock(block1);
      expect(result1.valid).toBe(true);
      
      // create transaction from miner to alice
      const transferAmount = 10n * 100000000n; // 10 BOLT
      const fee = 100000n; // 0.001 BOLT
      
      // get miner's current nonce
      const minerNonce = await blockchain.getNonce(miner.address);
      
      const tx1 = await createSignedTransaction(
        testConfig.chainId,
        miner.address,
        alice.address,
        transferAmount,
        minerNonce, // use current nonce
        fee,
        hexToBytes(miner.privateKey)
      );
      
      // mine second block with transaction
      const block2 = new BlockClass(
        2,
        Date.now() + 10000, // ensure timestamp is after block1
        block1.hash,
        [tx1.toObject()],
        1,
        bob.address
      );
      
      const coinbase2 = new TransactionClass(
        testConfig.chainId,
        null,
        bob.address,
        blockReward + fee, // reward + tx fee
        0,
        0n,
        block2.timestamp
      );
      block2.transactions = [coinbase2.toObject(), tx1.toObject()];
      block2.merkleRoot = block2.calculateMerkleRoot();
      await blockchain.prepareBlock(block2);
      block2.mine('sha256', 1000000);
      
      const result2 = await blockchain.addBlock(block2);
      if (!result2.valid) {
        console.error('Block2 failed:', result2.error);
      }
      expect(result2.valid).toBe(true);
      
      // check balances
      const minerBalance = await blockchain.getBalance(miner.address);
      const aliceBalance = await blockchain.getBalance(alice.address);
      const bobBalance = await blockchain.getBalance(bob.address);
      
      expect(minerBalance).toBe(blockReward - transferAmount - fee);
      expect(aliceBalance).toBe(transferAmount);
      expect(bobBalance).toBe(blockReward + fee);
      
      // check nonces
      const finalMinerNonce = await blockchain.getNonce(miner.address);
      expect(finalMinerNonce).toBe(1);
    });
  });
  
  describe('difficulty adjustment', () => {
    it('should maintain difficulty within adjustment interval', async () => {
      // mine blocks up to just before adjustment
      const minerAddress = generateAddress(testConfig.addressPrefix).address;
      for (let i = 1; i < testConfig.difficultyAdjustmentInterval; i++) {
        const previousBlock = await blockchain.getLatestBlock();
        const block = new BlockClass(
          i,
          previousBlock!.timestamp + 1000,
          previousBlock!.hash,
          [],
          1,
            minerAddress
        );
        
        const blockReward = blockchain.getBlockReward(i);
        const coinbase = new TransactionClass(
          testConfig.chainId,
          null,
          minerAddress,
          blockReward,
          0,
          0n,
          block.timestamp
        );
        block.transactions = [coinbase.toObject()];
        block.merkleRoot = block.calculateMerkleRoot();
        await blockchain.prepareBlock(block);
        block.mine('sha256', 1000000);
        
        const result = await blockchain.addBlock(block);
        if (!result.valid) {
          console.error(`Block ${i} failed to add:`, result.error);
        }
        expect(result.valid).toBe(true);
      }
      
      // difficulty should still be 1
      const difficulty = await blockchain.getDifficulty();
      expect(difficulty).toBe(1);
    });
  });
  
  describe('block reward', () => {
    it('should calculate correct initial reward', () => {
      const reward = blockchain.getBlockReward(1);
      expect(reward).toBe(testConfig.initialReward);
    });
    
    it('should halve reward at intervals', () => {
      const reward1 = blockchain.getBlockReward(1);
      const reward2 = blockchain.getBlockReward(testConfig.halvingInterval);
      const reward3 = blockchain.getBlockReward(testConfig.halvingInterval * 2);
      
      expect(reward2).toBe(reward1 / 2n);
      expect(reward3).toBe(reward2 / 2n);
    });
    
    it('should not exceed max supply', () => {
      // check very high block number
      const reward = blockchain.getBlockReward(10000000);
      expect(reward).toBeGreaterThanOrEqual(0n);
    });
  });
  
  describe('chain operations', () => {
    it('should iterate through chain', async () => {
      // mine a few blocks
      const minerAddress = generateAddress(testConfig.addressPrefix).address;
      for (let i = 1; i <= 3; i++) {
        const previousBlock = await blockchain.getLatestBlock();
        const timestamp = Date.now() + i * 1000;
        const block = new BlockClass(
          i,
          timestamp,
          previousBlock!.hash,
          [],
          1,
            minerAddress
        );
        
        const blockReward = blockchain.getBlockReward(i);
        const coinbase = new TransactionClass(
          testConfig.chainId,
          null,
          minerAddress,
          blockReward,
          0,
          0n,
          timestamp
        );
        block.transactions = [coinbase.toObject()];
        block.merkleRoot = block.calculateMerkleRoot();
        await blockchain.prepareBlock(block);
        block.mine('sha256', 1000000);
        
        const result = await blockchain.addBlock(block);
        if (!result.valid) {
          console.error(`Block ${i} failed to add:`, result.error);
        }
        expect(result.valid).toBe(true);
      }
      
      // iterate and count
      let count = 0;
      for await (const block of blockchain.iterateChain()) {
        expect(block.index).toBe(count);
        count++;
      }
      
      expect(count).toBe(4); // genesis + 3 blocks
    });
    
    it('should calculate all balances correctly', async () => {
      // use a valid base58 address for testing
      const minerAddress = generateAddress(testConfig.addressPrefix).address;
      
      // mine 3 blocks
      for (let i = 1; i <= 3; i++) {
        const previousBlock = await blockchain.getLatestBlock();
        const block = new BlockClass(
          i,
          Date.now() + i * 1000, // add delay to ensure timestamps are different
          previousBlock!.hash,
          [],
          1,
            minerAddress
        );
        
        const blockReward = blockchain.getBlockReward(i);
        const coinbase = new TransactionClass(
          testConfig.chainId,
          null,
          minerAddress,
          blockReward,
          0,
          0n,
          block.timestamp
        );
        block.transactions = [coinbase.toObject()];
        block.merkleRoot = block.calculateMerkleRoot();
        await blockchain.prepareBlock(block);
        block.mine('sha256', 1000000);
        
        const result = await blockchain.addBlock(block);
        if (!result.valid) {
          console.error(`Block ${i} failed to add:`, result.error);
        }
        expect(result.valid).toBe(true);
      }
      
      // calculate balances
      const balances = await blockchain.calculateAllBalances();
      
      // should have one address with 3 block rewards
      expect(balances.size).toBe(1);
      expect(balances.get(minerAddress)).toBe(
        testConfig.initialReward * 3n
      );
    });
    
    it('should verify chain integrity', async () => {
      // mine a block
      const previousBlock = await blockchain.getLatestBlock();
      const minerAddress = generateAddress(testConfig.addressPrefix).address;
      const block = new BlockClass(
        1,
        Date.now(),
        previousBlock!.hash,
        [],
        1,
        minerAddress
      );
      
      const blockReward = blockchain.getBlockReward(1);
      const coinbase = new TransactionClass(
        testConfig.chainId,
        null,
        minerAddress,
        blockReward,
        0,
        0n,
        block.timestamp
      );
      block.transactions = [coinbase.toObject()];
      block.merkleRoot = block.calculateMerkleRoot();
      await blockchain.prepareBlock(block);
      block.mine('sha256', 1000000);
      
      await blockchain.addBlock(block);
      
      // verify integrity
      const result = await blockchain.verifyChainIntegrity();
      expect(result.valid).toBe(true);
    });
    
    it('should track cumulative difficulty', async () => {
      // initial cumulative difficulty (genesis)
      let cumulative = await blockchain.getCumulativeDifficulty();
      expect(cumulative).toBe(1n); // genesis has difficulty 1
      
      // mine a block
      const previousBlock = await blockchain.getLatestBlock();
      const minerAddress = generateAddress(testConfig.addressPrefix).address;
      const block = new BlockClass(
        1,
        Date.now(),
        previousBlock!.hash,
        [],
        1,
        minerAddress
      );
      
      const blockReward = blockchain.getBlockReward(1);
      const coinbase = new TransactionClass(
        testConfig.chainId,
        null,
        minerAddress,
        blockReward,
        0,
        0n,
        block.timestamp
      );
      block.transactions = [coinbase.toObject()];
      block.merkleRoot = block.calculateMerkleRoot();
      await blockchain.prepareBlock(block);
      block.mine('sha256', 1000000);
      
      await blockchain.addBlock(block);
      
      // check updated cumulative difficulty
      cumulative = await blockchain.getCumulativeDifficulty();
      expect(cumulative).toBe(2n); // genesis (1) + new block (1)
    });
  });
  
  describe('block template', () => {
    it('should create valid block template', async () => {
      const minerAddress = generateAddress(testConfig.addressPrefix).address;
      const template = await blockchain.createBlockTemplate([], minerAddress);
      
      expect(template.height).toBe(1);
      expect(template.difficulty).toBe(1);
      expect(template.coinbaseValue).toBe(testConfig.initialReward);
      expect(template.transactions.length).toBe(1); // just coinbase
      
      // verify coinbase transaction
      const coinbase = template.transactions[0];
      expect(coinbase.from).toBeNull();
      expect(coinbase.to).toBe(minerAddress);
      expect(coinbase.amount).toBe(testConfig.initialReward);
    });
    
    it('should include transactions in template', async () => {
      // create wallets for the transactions
      const alice = generateAddress(testConfig.addressPrefix);
      const bob = generateAddress(testConfig.addressPrefix);
      const charlie = generateAddress(testConfig.addressPrefix);
      const dave = generateAddress(testConfig.addressPrefix);
      const miner = generateAddress(testConfig.addressPrefix);
      
      // create some transactions
      const tx1 = new TransactionClass(
        testConfig.chainId,
        alice.address,
        bob.address,
        1000000n,
        1,
        10000n,
        Date.now()
      );
      
      const tx2 = new TransactionClass(
        testConfig.chainId,
        charlie.address,
        dave.address,
        2000000n,
        1,
        20000n,
        Date.now()
      );
      
      const minerAddress = miner.address;
      const template = await blockchain.createBlockTemplate(
        [tx1.toObject(), tx2.toObject()],
        minerAddress
      );
      
      expect(template.transactions.length).toBe(3); // coinbase + 2 txs
      expect(template.coinbaseValue).toBe(
        testConfig.initialReward + 30000n // reward + fees
      );
    });
  });
});
