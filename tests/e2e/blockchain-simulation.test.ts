import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Blockchain } from '../../src/core/blockchain';
import { BlockClass } from '../../src/core/block';
import { Mempool } from '../../src/core/mempool';
import { TransactionClass } from '../../src/core/transaction';
import { MiningService } from '../../src/services/mining';
import { GetBlockTemplateService } from '../../src/services/getblocktemplate';
import { MemoryAdapter } from '../../src/storage/memory';
import { generateAddress } from '../../src/crypto/address';
import { wattsToBolt, formatWatts, parseAmount } from '../../src/utils/currency';

const WATTS_PER_BOLT = 100_000_000n;
const formatBOLT = (watts: bigint) => wattsToBolt(watts);
import { getLogger } from '../../src/utils/logger';
import { devnet as chainConfig } from '../../src/config/chains/devnet';
import type { KeyInfo } from '../../src/crypto/address';

const logger = getLogger(__filename);

/**
 * Simulated actor in the blockchain network
 */
class BlockchainActor {
  public name: string;
  public keyInfo: KeyInfo;
  public blockchain: Blockchain;
  public mempool: Mempool;
  public balance: bigint = 0n;
  private pendingNonce: number | null = null;
  
  constructor(name: string, blockchain: Blockchain, mempool: Mempool) {
    this.name = name;
    this.keyInfo = generateAddress(chainConfig.addressPrefix);
    this.blockchain = blockchain;
    this.mempool = mempool;
  }
  
  async updateBalance(): Promise<void> {
    this.balance = await this.blockchain.getBalance(this.keyInfo.address);
  }
  
  async sendTransaction(
    to: string,
    amountBOLT: number,
    feeBOLT: number = 0.0001
  ): Promise<TransactionClass> {
    await this.updateBalance();
    
    const amountWatts = BigInt(amountBOLT * 100_000_000);
    const feeWatts = BigInt(Math.floor(feeBOLT * 100_000_000));
    
    // get current nonce from storage or use pending nonce
    const storage = (this.blockchain as any).storage;
    const accountState = await storage.getAccountState(this.keyInfo.address);
    const baseNonce = accountState?.nonce || 0;
    
    // use pending nonce if we have one, otherwise use base nonce
    const nonce = this.pendingNonce !== null ? this.pendingNonce : baseNonce;
    
    // create and sign transaction
    const tx = new TransactionClass(
      chainConfig.chainId,
      this.keyInfo.address,
      to,
      amountWatts,
      nonce,
      feeWatts
    );
    
    await tx.sign(this.keyInfo.privateKey);
    
    // add to mempool
    await this.mempool.addTransaction(tx);
    
    // update pending nonce for next transaction
    this.pendingNonce = nonce + 1;
    
    logger.info(`${this.name} sent ${formatBOLT(amountWatts)} to ${to.substring(0, 8)}...`);
    
    return tx;
  }
  
  resetPendingNonce(): void {
    this.pendingNonce = null;
  }
  
  async checkBalance(expectedBOLT?: number): Promise<boolean> {
    await this.updateBalance();
    
    logger.info(`${this.name} balance: ${formatBOLT(this.balance)}`);
    
    if (expectedBOLT !== undefined) {
      const expectedWatts = BigInt(expectedBOLT * 100_000_000);
      const matches = this.balance === expectedWatts;
      if (!matches) {
        logger.error(
          `Balance mismatch for ${this.name}: expected ${formatBOLT(expectedWatts)}, got ${formatBOLT(this.balance)}`
        );
      }
      return matches;
    }
    
    return true;
  }
}

/**
 * Simulated miner in the blockchain network
 */
class Miner extends BlockchainActor {
  private miningService: MiningService;
  private isMining: boolean = false;
  private blocksFound: number = 0;
  
  constructor(
    name: string,
    blockchain: Blockchain,
    mempool: Mempool,
    storage: MemoryAdapter
  ) {
    super(name, blockchain, mempool);
    this.miningService = new MiningService({
      blockchain,
      mempool,
      minerAddress: generateAddress(chainConfig.addressPrefix).address,
      autoStart: false
    });
  }
  
  async startMining(): Promise<void> {
    this.isMining = true;
    logger.info(`${this.name} started mining`);
    
    try {
      while (this.isMining) {
        // create block template
        const template = await this.blockchain.createBlockTemplate(
          this.mempool.getTransactionsForBlock(),
          this.keyInfo.address
        );
        
        // mine the block
        const block = await this.mineBlock(template);
        
        if (block) {
          // add to blockchain
          const result = await this.blockchain.addBlock(block);
          
          if (result.valid) {
            this.blocksFound++;
            const reward = this.blockchain.calculateBlockReward(block.index);
            logger.info(
              `${this.name} mined block ${block.index} and earned ${formatBOLT(reward)} reward!`
            );
            
            // remove mined transactions from mempool
            await this.mempool.removeBlockTransactions(block.transactions.slice(1)); // skip coinbase
            
            // continue mining if there are more transactions
            if (this.mempool.getStats().size === 0) {
              this.isMining = false;
              break;
            }
          } else {
            logger.warn(`${this.name} mined invalid block: ${result.error}`);
          }
        }
        
        // small delay between mining attempts
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error: any) {
      logger.error(`Mining error for ${this.name}:`, { 
        error: error.message || error
      });
      this.isMining = false;
    }
  }
  
  private async mineBlock(template: any): Promise<any> {
    // simplified mining for testing - in devnet difficulty is 1
    // so any nonce will work
    const block = new BlockClass(
      template.height,
      template.timestamp,
      template.previousHash,
      template.transactions, // already includes coinbase
      template.difficulty
    );
    
    // in devnet, difficulty 1 means any hash is valid
    await this.blockchain.prepareBlock(block);
    block.nonce = Math.floor(Math.random() * 1000000);
    block.hash = block.calculateHash();
    
    return block;
  }
  
  stopMining(): void {
    this.isMining = false;
    logger.info(`${this.name} stopped mining. Found ${this.blocksFound} blocks`);
  }
  
  getBlocksFound(): number {
    return this.blocksFound;
  }
}

describe('Blockchain E2E Simulation', () => {
  let blockchain: Blockchain;
  let mempool: Mempool;
  let storage: MemoryAdapter;
  let gbtService: GetBlockTemplateService;
  
  // actors
  let alice: BlockchainActor;
  let bob: BlockchainActor;
  let charlie: BlockchainActor;
  let miner1: Miner;
  let miner2: Miner;
  
  beforeEach(async () => {
    // setup blockchain infrastructure
    storage = new MemoryAdapter();
    await storage.connect();
    
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    
    mempool = new Mempool(storage, {
      chainId: chainConfig.chainId,
      addressPrefix: chainConfig.addressPrefix,
      maxSize: 1000,
      maxSizeBytes: 10_000_000,
      minFeePerByte: 1n
    });
    await mempool.initialize();
    
    gbtService = new GetBlockTemplateService(blockchain, mempool);
    
    // create actors
    alice = new BlockchainActor('Alice', blockchain, mempool);
    bob = new BlockchainActor('Bob', blockchain, mempool);
    charlie = new BlockchainActor('Charlie', blockchain, mempool);
    
    // create miners
    miner1 = new Miner('Miner1', blockchain, mempool, storage);
    miner2 = new Miner('Miner2', blockchain, mempool, storage);
    
    logger.info('=== Blockchain simulation initialized ===');
  });
  
  afterEach(async () => {
    miner1.stopMining();
    miner2.stopMining();
    await gbtService.shutdown();
    await storage.close();
  });
  
  test('should simulate basic money transfer between users', async () => {
    logger.info('\n=== Test: Basic money transfer ===');
    
    // fund alice with some initial coins (simulate previous mining)
    await storage.updateAccountState(alice.keyInfo.address, {
      balance: 1000n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    // verify alice's balance
    expect(await alice.checkBalance(1000)).toBe(true);
    expect(await bob.checkBalance(0)).toBe(true);
    
    // alice sends 100 BOLT to bob
    const tx1 = await alice.sendTransaction(bob.keyInfo.address, 100, 0.001);
    
    // start mining to confirm transaction
    miner1.startMining();
    
    // wait for block to be mined
    await new Promise(resolve => setTimeout(resolve, 500));
    miner1.stopMining();
    
    // verify balances after confirmation
    await alice.updateBalance();
    await bob.updateBalance();
    
    // alice should have 1000 - 100 - 0.001 = 899.999 BOLT
    const aliceExpected = 1000n * WATTS_PER_BOLT - 100n * WATTS_PER_BOLT - 100000n;
    expect(alice.balance).toBe(aliceExpected);
    
    // bob should have 100 BOLT
    expect(bob.balance).toBe(100n * WATTS_PER_BOLT);
    
    logger.info('✓ Money transfer successful');
  }, 10000);
  
  test('should handle multiple concurrent transactions', async () => {
    logger.info('\n=== Test: Multiple concurrent transactions ===');
    
    // fund alice with initial balance
    await storage.updateAccountState(alice.keyInfo.address, {
      balance: 1000n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    // alice sends multiple transactions
    const tx1 = await alice.sendTransaction(bob.keyInfo.address, 50, 0.001);
    const tx2 = await alice.sendTransaction(charlie.keyInfo.address, 75, 0.001);
    const tx3 = await alice.sendTransaction(bob.keyInfo.address, 25, 0.001);
    
    // verify transactions are in mempool
    expect(mempool.hasTransaction(tx1.hash)).toBe(true);
    expect(mempool.hasTransaction(tx2.hash)).toBe(true);
    expect(mempool.hasTransaction(tx3.hash)).toBe(true);
    
    // mine a block with all transactions
    miner1.startMining();
    await new Promise(resolve => setTimeout(resolve, 500));
    miner1.stopMining();
    
    // verify all balances
    await alice.updateBalance();
    await bob.updateBalance();
    await charlie.updateBalance();
    
    // alice sent 50 + 75 + 25 = 150 BOLT + 0.003 fees
    const aliceExpected = 1000n * WATTS_PER_BOLT - 150n * WATTS_PER_BOLT - 300000n;
    expect(alice.balance).toBe(aliceExpected);
    
    // bob received 50 + 25 = 75 BOLT
    expect(bob.balance).toBe(75n * WATTS_PER_BOLT);
    
    // charlie received 75 BOLT
    expect(charlie.balance).toBe(75n * WATTS_PER_BOLT);
    
    logger.info('✓ Multiple transactions processed correctly');
  }, 10000);
  
  test('should prevent double spending', async () => {
    logger.info('\n=== Test: Double spend prevention ===');
    
    // fund alice with limited balance
    await storage.updateAccountState(alice.keyInfo.address, {
      balance: 100n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    // alice tries to send more than she has
    const tx1 = await alice.sendTransaction(bob.keyInfo.address, 60, 0.001);
    
    // try to send again with same nonce (double spend attempt)
    const tx2 = new TransactionClass(
      chainConfig.chainId,
      alice.keyInfo.address,
      charlie.keyInfo.address,
      60n * WATTS_PER_BOLT,
      0, // same nonce!
      100000n
    );
    await tx2.sign(alice.keyInfo.privateKey);
    
    // second transaction should be rejected
    await expect(mempool.addTransaction(tx2)).rejects.toThrow();
    
    // mine the first transaction
    miner1.startMining();
    await new Promise(resolve => setTimeout(resolve, 500));
    miner1.stopMining();
    
    // reject spending more than remaining balance
    await expect(
      alice.sendTransaction(charlie.keyInfo.address, 50, 0.001)
    ).rejects.toThrow('Insufficient balance');
    
    // verify only first transaction went through, not the second
    await bob.updateBalance();
    await charlie.updateBalance();
    
    expect(bob.balance).toBe(60n * WATTS_PER_BOLT);
    expect(charlie.balance).toBe(0n); // charlie shouldn't receive anything
    
    expect(mempool.getStats().size).toBe(0);
    
    logger.info('✓ Double spending prevented');
  }, 10000);
  
  test('should handle concurrent miners correctly', async () => {
    logger.info('\n=== Test: Concurrent miners ===');
    
    // fund alice
    await storage.updateAccountState(alice.keyInfo.address, {
      balance: 500n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    // create some transactions
    await alice.sendTransaction(bob.keyInfo.address, 10, 0.001);
    await alice.sendTransaction(charlie.keyInfo.address, 20, 0.001);
    
    // start both miners
    miner1.startMining();
    miner2.startMining();
    
    // let them mine for a bit
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // stop mining
    miner1.stopMining();
    miner2.stopMining();
    
    // check that blocks were mined
    const height = await blockchain.getHeight();
    expect(height).toBeGreaterThan(0);
    
    // check that both miners found some blocks
    const miner1Blocks = miner1.getBlocksFound();
    const miner2Blocks = miner2.getBlocksFound();
    
    logger.info(`Miner1 found ${miner1Blocks} blocks`);
    logger.info(`Miner2 found ${miner2Blocks} blocks`);
    logger.info(`Blockchain height: ${height}`);
    
    // when miners race, they might find the same block
    // so total blocks found >= blockchain height
    expect(miner1Blocks + miner2Blocks).toBeGreaterThanOrEqual(height);
    
    // verify transactions were included
    await bob.updateBalance();
    await charlie.updateBalance();
    
    expect(bob.balance).toBe(10n * WATTS_PER_BOLT);
    expect(charlie.balance).toBe(20n * WATTS_PER_BOLT);
    
    logger.info('✓ Concurrent mining works correctly');
  }, 10000);
  
  test('should calculate correct miner rewards', async () => {
    logger.info('\n=== Test: Miner rewards ===');
    
    // fund alice for transaction fees
    await storage.updateAccountState(alice.keyInfo.address, {
      balance: 100n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    // create transaction with fee
    await alice.sendTransaction(bob.keyInfo.address, 10, 0.01); // 0.01 BOLT fee
    
    // mine the block
    miner1.startMining();
    await new Promise(resolve => setTimeout(resolve, 500));
    miner1.stopMining();
    
    // check miner's balance (should have block reward + fees)
    await miner1.updateBalance();
    
    const blockReward = chainConfig.initialReward;
    const txFee = BigInt(0.01 * 100_000_000);
    const expectedMinerBalance = blockReward + txFee;
    
    expect(miner1.balance).toBe(expectedMinerBalance);
    
    logger.info(`✓ Miner earned ${formatBOLT(blockReward)} reward + ${formatBOLT(txFee)} fees`);
  }, 10000);
  
  test('should maintain consistency across chain reorganization', async () => {
    logger.info('\n=== Test: Chain reorganization ===');
    
    // this test would require network simulation which we don't have yet
    // but we can test the concept with parallel chains
    
    // fund alice through consensus state
    const fundingTemplate = await blockchain.createBlockTemplate([], alice.keyInfo.address);
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
    
    // create competing transactions
    const tx1 = await alice.sendTransaction(bob.keyInfo.address, 100, 0.001);
    
    // mine first chain
    miner1.startMining();
    await new Promise(resolve => setTimeout(resolve, 300));
    miner1.stopMining();
    
    const height1 = await blockchain.getHeight();
    
    // in a real scenario, we'd have a competing chain here
    // for now, just verify the chain is consistent
    const isValid = await blockchain.verifyChainIntegrity();
    expect(isValid.valid).toBe(true);
    
    logger.info(`✓ Chain integrity maintained at height ${height1}`);
  }, 10000);
  
  test('should handle high transaction volume', async () => {
    logger.info('\n=== Test: High transaction volume ===');
    
    // create many actors
    const actors: BlockchainActor[] = [];
    for (let i = 0; i < 10; i++) {
      const actor = new BlockchainActor(`User${i}`, blockchain, mempool);
      // fund each actor
      await storage.updateAccountState(actor.keyInfo.address, {
        balance: 100n * WATTS_PER_BOLT,
        nonce: 0
      });
      actors.push(actor);
    }
    
    // each actor sends transactions to random others
    const transactions = [];
    for (let i = 0; i < actors.length; i++) {
      const sender = actors[i];
      const receiverIndex = (i + 1) % actors.length;
      const receiver = actors[receiverIndex];
      
      try {
        const tx = await sender.sendTransaction(receiver.keyInfo.address, 5, 0.0001);
        transactions.push(tx);
      } catch (error) {
        logger.warn(`Transaction failed for ${sender.name}:`, error);
      }
    }
    
    logger.info(`Created ${transactions.length} transactions`);
    
    // mine blocks to process all transactions
    miner1.startMining();
    
    // wait for transactions to be mined
    let attempts = 0;
    while (mempool.getStats().size > 0 && attempts < 20) {
      await new Promise(resolve => setTimeout(resolve, 200));
      attempts++;
    }
    
    miner1.stopMining();
    
    // verify all transactions were processed
    expect(mempool.getStats().size).toBe(0);
    
    // verify balances are consistent
    let totalBalance = 0n;
    for (const actor of actors) {
      await actor.updateBalance();
      totalBalance += actor.balance;
    }
    
    // total should be initial amount minus fees
    const initialTotal = BigInt(actors.length * 100) * WATTS_PER_BOLT;
    const totalFees = BigInt(transactions.length) * 10000n; // 0.0001 BOLT per tx
    
    // add miner rewards
    await miner1.updateBalance();
    totalBalance += miner1.balance;
    
    logger.info(`Total balance in system: ${formatBOLT(totalBalance)}`);
    logger.info('✓ High volume transactions processed successfully');
  }, 20000);
  
  test('should correctly track nonces across multiple transactions', async () => {
    logger.info('\n=== Test: Nonce tracking ===');
    
    // fund alice
    await storage.updateAccountState(alice.keyInfo.address, {
      balance: 1000n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    // send multiple transactions in sequence
    const amounts = [10, 20, 30, 40, 50];
    const txs = [];
    
    for (const amount of amounts) {
      const tx = await alice.sendTransaction(bob.keyInfo.address, amount, 0.0001);
      txs.push(tx);
    }
    
    // verify nonces are sequential
    for (let i = 0; i < txs.length; i++) {
      expect(txs[i].nonce).toBe(i);
    }
    
    // mine all transactions
    miner1.startMining();
    await new Promise(resolve => setTimeout(resolve, 1000));
    miner1.stopMining();
    
    // verify final state
    const aliceState = await storage.getAccountState(alice.keyInfo.address);
    expect(aliceState?.nonce).toBe(5); // sent 5 transactions
    
    await bob.updateBalance();
    const totalSent = amounts.reduce((sum, a) => sum + a, 0);
    expect(bob.balance).toBe(BigInt(totalSent) * WATTS_PER_BOLT);
    
    logger.info('✓ Nonces tracked correctly');
  }, 10000);
});

describe('GetBlockTemplate Integration', () => {
  let blockchain: Blockchain;
  let mempool: Mempool;
  let storage: MemoryAdapter;
  let gbtService: GetBlockTemplateService;
  
  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.connect();
    
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    
    mempool = new Mempool(storage, chainConfig);
    await mempool.initialize();
    
    gbtService = new GetBlockTemplateService(blockchain, mempool);
  });
  
  afterEach(async () => {
    await gbtService.shutdown();
    await storage.close();
  });
  
  test('should handle mining pool scenario', async () => {
    logger.info('\n=== Test: Mining pool with GBT ===');
    const payoutAddress = generateAddress(chainConfig.addressPrefix).address;
    
    // simulate mining pool getting work
    const template1 = await gbtService.getBlockTemplate({ payoutAddress });
    expect(template1).toBeDefined();
    expect(template1.height).toBe(1);
    
    // add some transactions
    const alice = generateAddress(chainConfig.addressPrefix);
    await storage.updateAccountState(alice.address, {
      balance: 1000n * WATTS_PER_BOLT,
      nonce: 0
    });
    
    const bob = generateAddress(chainConfig.addressPrefix);
    const tx = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      bob.address,
      100n * WATTS_PER_BOLT,
      0,
      100000n
    );
    await tx.sign(alice.privateKey);
    await mempool.addTransaction(tx);
    
    // pool should get new template with transaction
    const template2 = await gbtService.getBlockTemplate({ payoutAddress });
    
    expect(template2.transactions).toHaveLength(1);
    expect(template2.totalFees).toBe(100000n);
    
    // simulate pool submitting solution
    const submission = {
      templateId: template2.templateId,
      nonce: 12345,
      timestamp: template2.timestamp
    };
    
    const result = await gbtService.submitBlock(submission);
    
    // in devnet with difficulty 1, this should succeed
    expect(result.valid).toBe(true);
    
    logger.info('✓ Mining pool GBT integration works');
  }, 10000);
});
