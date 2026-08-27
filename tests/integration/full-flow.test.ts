import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Blockchain } from '../../src/core/blockchain';
import { BlockClass } from '../../src/core/block';
import { Mempool } from '../../src/core/mempool';
import { TransactionClass } from '../../src/core/transaction';
import { GetBlockTemplateService } from '../../src/services/getblocktemplate';
import { MemoryAdapter } from '../../src/storage/memory';
import { generateAddress } from '../../src/crypto/address';
import { wattsToBolt } from '../../src/utils/currency';
import { devnet as chainConfig } from '../../src/config/chains/devnet';
import { getLogger } from '../../src/utils/logger';

const logger = getLogger(__filename);
const WATTS_PER_BOLT = 100_000_000n;

describe('Full Blockchain Flow Integration', () => {
  let blockchain: Blockchain;
  let mempool: Mempool;
  let storage: MemoryAdapter;
  let gbtService: GetBlockTemplateService;
  
  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.connect();
    
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    
    mempool = new Mempool(storage, {
      chainId: chainConfig.chainId,
      addressPrefix: chainConfig.addressPrefix,
      maxSize: 1000,
      minFeePerByte: 1n
    });
    await mempool.initialize();
    
    gbtService = new GetBlockTemplateService(blockchain, mempool);
  });
  
  afterEach(async () => {
    await gbtService.shutdown();
    await storage.close();
  });
  
  test('should handle complete transaction flow from creation to confirmation', async () => {
    // Step 1: Create accounts
    const alice = generateAddress(chainConfig.addressPrefix);
    const bob = generateAddress(chainConfig.addressPrefix);
    const charlie = generateAddress(chainConfig.addressPrefix);
    const miner = generateAddress(chainConfig.addressPrefix);
    
    logger.info('Created accounts', {
      alice: alice.address.substring(0, 8) + '...',
      bob: bob.address.substring(0, 8) + '...',
      charlie: charlie.address.substring(0, 8) + '...',
      miner: miner.address.substring(0, 8) + '...'
    });
    
    // Step 2: Fund Alice by mining a block
    const fundingTemplate = await blockchain.createBlockTemplate([], alice.address);
    const fundingBlock = new BlockClass(
      fundingTemplate.height,
      fundingTemplate.timestamp,
      fundingTemplate.previousHash,
      fundingTemplate.transactions,
      fundingTemplate.difficulty
    );
    await blockchain.prepareBlock(fundingBlock);
    fundingBlock.hash = fundingBlock.calculateHash();
    expect((await blockchain.addBlock(fundingBlock)).valid).toBe(true);
    
    const aliceInitialBalance = await blockchain.getBalance(alice.address);
    expect(aliceInitialBalance).toBe(1000n * WATTS_PER_BOLT);
    logger.info(`Alice initial balance: ${wattsToBolt(aliceInitialBalance)} BOLT`);
    
    // Step 3: Create transactions
    const tx1 = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      bob.address,
      100n * WATTS_PER_BOLT,
      0,
      100_000n // 0.001 BOLT fee
    );
    await tx1.sign(alice.privateKey);
    
    const tx2 = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      charlie.address,
      50n * WATTS_PER_BOLT,
      1,
      100_000n
    );
    await tx2.sign(alice.privateKey);
    
    logger.info('Created transactions', {
      tx1: tx1.hash.substring(0, 8) + '...',
      tx2: tx2.hash.substring(0, 8) + '...'
    });
    
    // Step 4: Add transactions to mempool
    await mempool.addTransaction(tx1);
    await mempool.addTransaction(tx2);
    
    const mempoolStats = mempool.getStats();
    expect(mempoolStats.size).toBe(2);
    expect(mempoolStats.totalFees).toBe(200_000n);
    logger.info('Mempool stats', mempoolStats);
    
    // Step 5: Get block template (using blockchain's createBlockTemplate directly)
    const mempoolTxs = mempool.getTransactionsForBlock();
    
    const template = await blockchain.createBlockTemplate(
      mempoolTxs,
      miner.address
    );
    
    expect(template.transactions.length).toBe(3); // coinbase + 2 txs
    logger.info('Block template created', {
      height: template.height,
      transactions: template.transactions.length - 1, // exclude coinbase
      fees: wattsToBolt(template.coinbaseValue - blockchain.calculateBlockReward(template.height))
    });
    
    // Step 6: Mine the block    
    const block = new BlockClass(
      template.height,
      template.timestamp,
      template.previousHash,
      template.transactions, // already includes coinbase
      template.difficulty
    );
    
    // In devnet, difficulty is 1, so any nonce works
    await blockchain.prepareBlock(block);
    block.nonce = 12345;
    block.hash = block.calculateHash();
    
    // Step 7: Add block to blockchain
    const result = await blockchain.addBlock(block);
    expect(result.valid).toBe(true);
    logger.info(`Block ${block.index} mined successfully`);
    
    // Step 8: Remove transactions from mempool
    await mempool.removeBlockTransactions(block.transactions.slice(1)); // skip coinbase
    expect(mempool.getStats().size).toBe(0);
    
    // Step 9: Verify final balances
    const aliceFinal = await blockchain.getBalance(alice.address);
    const bobFinal = await blockchain.getBalance(bob.address);
    const charlieFinal = await blockchain.getBalance(charlie.address);
    const minerFinal = await blockchain.getBalance(miner.address);
    
    // Alice: 1000 - 100 - 50 - 0.002 fees = 849.998 BOLT
    // 1000 BOLT = 100_000_000_000 watts
    // 100 BOLT = 10_000_000_000 watts  
    // 50 BOLT = 5_000_000_000 watts
    // 0.001 BOLT fee * 2 = 200_000 watts
    // Total spent: 15_000_200_000 watts
    // Remaining: 100_000_000_000 - 15_000_200_000 = 84_999_800_000 watts
    expect(aliceFinal).toBe(84_999_800_000n);
    expect(bobFinal).toBe(100n * WATTS_PER_BOLT);
    expect(charlieFinal).toBe(50n * WATTS_PER_BOLT);
    
    logger.info('Final balances:', {
      alice: wattsToBolt(aliceFinal),
      bob: wattsToBolt(bobFinal),
      charlie: wattsToBolt(charlieFinal),
      miner: wattsToBolt(minerFinal)
    });
    
    // Step 10: Verify account states
    const aliceState = await storage.getAccountState(alice.address);
    expect(aliceState?.nonce).toBe(2); // sent 2 transactions
    
    // Step 11: Verify blockchain integrity
    const integrity = await blockchain.verifyChainIntegrity();
    expect(integrity.valid).toBe(true);
    
    const height = await blockchain.getHeight();
    expect(height).toBe(2);
    
    logger.info('✓ Complete transaction flow test passed');
  });
  
  test('should prevent double spending attempts', async () => {
    const alice = generateAddress(chainConfig.addressPrefix);
    const bob = generateAddress(chainConfig.addressPrefix);
    
    // Fund alice
    await storage.updateAccountState(alice.address, {
      balance: 100n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    // Create valid transaction
    const tx1 = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      bob.address,
      60n * WATTS_PER_BOLT,
      0,
      100_000n
    );
    await tx1.sign(alice.privateKey);
    await mempool.addTransaction(tx1);
    
    // Try to double spend with same nonce
    const tx2 = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      bob.address,
      60n * WATTS_PER_BOLT,
      0, // same nonce!
      100_000n
    );
    await tx2.sign(alice.privateKey);
    
    // Should reject duplicate nonce
    await expect(mempool.addTransaction(tx2)).rejects.toThrow();
    
    // Try to spend more than balance
    const tx3 = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      bob.address,
      150n * WATTS_PER_BOLT, // more than she has
      1,
      100_000n
    );
    await tx3.sign(alice.privateKey);
    
    // Mempool rejects cumulative overspend before mining
    await expect(mempool.addTransaction(tx3)).rejects.toThrow('Insufficient balance');
    
    // Mine block with first transaction
    const template = await blockchain.createBlockTemplate(
      [tx1], // only include first tx
      generateAddress(chainConfig.addressPrefix).address
    );
    
    const block = new BlockClass(
      template.height,
      template.timestamp,
      template.previousHash,
      template.transactions, // already includes coinbase and tx1
      template.difficulty
    );
    await blockchain.prepareBlock(block);
    block.nonce = 1;
    block.hash = block.calculateHash();
    
    const result = await blockchain.addBlock(block);
    expect(result.valid).toBe(true);
    
    // Verify bob received the money only once
    const bobBalance = await blockchain.getBalance(bob.address);
    expect(bobBalance).toBe(60n * WATTS_PER_BOLT);
    
    logger.info('✓ Double spending prevented');
  });
  
  test('should handle transaction fee distribution correctly', async () => {
    const alice = generateAddress(chainConfig.addressPrefix);
    const bob = generateAddress(chainConfig.addressPrefix);
    const miner = generateAddress(chainConfig.addressPrefix);
    
    // Fund alice
    await storage.updateAccountState(alice.address, {
      balance: 500n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    // Create transaction with significant fee
    const tx = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      bob.address,
      100n * WATTS_PER_BOLT,
      0,
      1n * WATTS_PER_BOLT // 1 BOLT fee
    );
    await tx.sign(alice.privateKey);
    await mempool.addTransaction(tx);
    
    // Mine block
    const template = await blockchain.createBlockTemplate(
      mempool.getTransactionsForBlock(),
      miner.address
    );
    
    expect(template.coinbaseValue - chainConfig.initialReward).toBe(1n * WATTS_PER_BOLT);
    
    const block = new BlockClass(
      template.height,
      template.timestamp,
      template.previousHash,
      template.transactions, // already includes coinbase
      template.difficulty
    );
    await blockchain.prepareBlock(block);
    block.nonce = 1;
    block.hash = block.calculateHash();
    
    await blockchain.addBlock(block);
    
    // Verify miner received block reward + fees
    const minerBalance = await blockchain.getBalance(miner.address);
    const expectedReward = chainConfig.initialReward + 1n * WATTS_PER_BOLT;
    expect(minerBalance).toBe(expectedReward);
    
    logger.info(`✓ Miner received ${wattsToBolt(minerBalance)} BOLT (reward + fees)`);
  });
  
  test('should maintain consistency with multiple blocks', async () => {
    const accounts = Array.from({ length: 5 }, () => generateAddress(chainConfig.addressPrefix));
    const miner = generateAddress(chainConfig.addressPrefix);
    
    // Fund first account by mining a block
    const fundingTemplate = await blockchain.createBlockTemplate([], accounts[0].address);
    const fundingBlock = new BlockClass(
      fundingTemplate.height,
      fundingTemplate.timestamp,
      fundingTemplate.previousHash,
      fundingTemplate.transactions,
      fundingTemplate.difficulty
    );
    await blockchain.prepareBlock(fundingBlock);
    fundingBlock.hash = fundingBlock.calculateHash();
    expect((await blockchain.addBlock(fundingBlock)).valid).toBe(true);
    
    // Mine multiple blocks with transactions
    for (let blockNum = 0; blockNum < 3; blockNum++) {
      // Create transaction for this block
      const sender = accounts[blockNum];
      const receiver = accounts[blockNum + 1];
      
      const senderState = await storage.getAccountState(sender.address);
      if (senderState && senderState.balance > 10n * WATTS_PER_BOLT) {
        const tx = new TransactionClass(
          chainConfig.chainId,
          sender.address,
          receiver.address,
          10n * WATTS_PER_BOLT,
          senderState.nonce,
          100_000n
        );
        await tx.sign(sender.privateKey);
        await mempool.addTransaction(tx);
      }
      
      // Mine block
      const template = await blockchain.createBlockTemplate(
        mempool.getTransactionsForBlock(),
        miner.address
      );
      
      const block = new BlockClass(
        template.height,
        template.timestamp,
        template.previousHash,
        template.transactions, // already includes coinbase
        template.difficulty,
        template.chainVersionHash
      );
      await blockchain.prepareBlock(block);
      block.nonce = blockNum;
      block.hash = block.calculateHash();
      
      const result = await blockchain.addBlock(block);
      expect(result.valid).toBe(true);
      
      // Clear mempool
      await mempool.removeBlockTransactions(template.transactions.slice(1)); // skip coinbase
      
      logger.info(`Block ${block.index} mined with ${template.transactions.length} transactions`);
    }
    
    // Verify chain integrity
    const integrity = await blockchain.verifyChainIntegrity();
    expect(integrity.valid).toBe(true);
    
    const height = await blockchain.getHeight();
    expect(height).toBe(4);
    
    // Verify cumulative difficulty increased
    const cumulativeDifficulty = await blockchain.getCumulativeDifficulty();
    expect(cumulativeDifficulty).toBeGreaterThan(0n);
    
    logger.info('✓ Multiple blocks processed consistently');
  });
  
  test('should handle mempool transaction prioritization', async () => {
    const bob = generateAddress(chainConfig.addressPrefix);
    
    // Create multiple senders with funds
    const senders = [];
    const fees = [1000n, 5000n, 2000n, 10000n, 500n]; // different fee amounts
    
    for (let i = 0; i < fees.length; i++) {
      const sender = generateAddress(chainConfig.addressPrefix);
      senders.push(sender);
      
      // Fund each sender
      await storage.updateAccountState(sender.address, {
        balance: 1000n * WATTS_PER_BOLT,
        nonce: 0
      });
    }
    
    // Create transactions with different fees from different senders
    const txs = [];
    
    for (let i = 0; i < fees.length; i++) {
      const tx = new TransactionClass(
        chainConfig.chainId,
        senders[i].address,
        bob.address,
        10n * WATTS_PER_BOLT,
        0, // all have nonce 0 since different senders
        fees[i]
      );
      await tx.sign(senders[i].privateKey);
      await mempool.addTransaction(tx);
      txs.push(tx);
    }
    
    // Get transactions for block (should be sorted by fee)
    const blockTxs = mempool.getTransactionsForBlock(1000); // small block size
    
    // Verify high-fee transactions are prioritized
    expect(blockTxs.length).toBeGreaterThan(0);
    expect(blockTxs.length).toBeLessThanOrEqual(fees.length);
    
    // Check that transactions are sorted by fee (highest first)
    for (let i = 1; i < blockTxs.length; i++) {
      const prevFee = blockTxs[i - 1].fee || 0n;
      const currFee = blockTxs[i].fee || 0n;
      expect(prevFee).toBeGreaterThanOrEqual(currFee);
    }
    
    logger.info('✓ Mempool prioritizes high-fee transactions');
  });
  
  test('should track nonces correctly across multiple transactions', async () => {
    const alice = generateAddress(chainConfig.addressPrefix);
    const bob = generateAddress(chainConfig.addressPrefix);
    
    // Fund alice
    await storage.updateAccountState(alice.address, {
      balance: 1000n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    // Send multiple transactions
    const txCount = 5;
    const txs = [];
    
    for (let i = 0; i < txCount; i++) {
      const tx = new TransactionClass(
        chainConfig.chainId,
        alice.address,
        bob.address,
        10n * WATTS_PER_BOLT,
        i, // sequential nonces
        100_000n
      );
      await tx.sign(alice.privateKey);
      await mempool.addTransaction(tx);
      txs.push(tx);
    }
    
    // Mine all transactions in one block
    const template = await blockchain.createBlockTemplate(
      mempool.getTransactionsForBlock(),
      generateAddress(chainConfig.addressPrefix).address
    );
    
    expect(template.transactions).toHaveLength(txCount + 1); // +1 for coinbase
    
    const block = new BlockClass(
      template.height,
      template.timestamp,
      template.previousHash,
      template.transactions, // already includes coinbase
      template.difficulty
    );
    await blockchain.prepareBlock(block);
    block.nonce = 1;
    block.hash = block.calculateHash();
    
    const result = await blockchain.addBlock(block);
    expect(result.valid).toBe(true);
    
    // Verify alice's nonce is updated correctly
    const aliceState = await storage.getAccountState(alice.address);
    expect(aliceState?.nonce).toBe(txCount);
    
    // Verify bob received all transfers
    const bobBalance = await blockchain.getBalance(bob.address);
    expect(bobBalance).toBe(BigInt(txCount * 10) * WATTS_PER_BOLT);
    
    logger.info('✓ Nonces tracked correctly for multiple transactions');
  });
});
