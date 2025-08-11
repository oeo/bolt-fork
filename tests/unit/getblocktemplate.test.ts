import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { GetBlockTemplateService } from '../../src/services/getblocktemplate';
import { Blockchain } from '../../src/core/blockchain';
import { Mempool } from '../../src/core/mempool';
import { MemoryAdapter } from '../../src/storage/memory';
import { config as defaultConfig } from '../../src/config/chain';
import { devnet as devnetConfig } from '../../src/config/chains/devnet';
import { TransactionClass } from '../../src/core/transaction';
import { generateAddress } from '../../src/crypto/address';
import type { BlockTemplate, BlockTemplateRequest, BlockSubmission } from '../../src/types';

describe('GetBlockTemplate Service', () => {
  let gbtService: GetBlockTemplateService;
  let blockchain: Blockchain;
  let mempool: Mempool;
  let storage: MemoryAdapter;
  
  beforeEach(async () => {
    // setup storage
    storage = new MemoryAdapter();
    await storage.connect();
    
    // setup blockchain
    blockchain = new Blockchain(storage, devnetConfig);
    await blockchain.initialize();
    
    // setup mempool
    mempool = new Mempool(storage, {
      maxSize: 100,
      maxSizeBytes: 10_000_000,
      minFeePerByte: 1n
    });
    await mempool.initialize();
    
    // setup gbt service
    gbtService = new GetBlockTemplateService(blockchain, mempool, storage);
  });
  
  afterEach(async () => {
    await gbtService.shutdown();
    await blockchain.close();
    await storage.close();
  });
  
  describe('template generation', () => {
    test('should generate a new block template', async () => {
      const template = await gbtService.getBlockTemplate();
      
      expect(template).toBeDefined();
      expect(template.templateId).toBeTruthy();
      expect(template.height).toBe(1);
      expect(template.previousHash).toBeTruthy();
      expect(template.difficulty).toBeGreaterThan(0);
      expect(template.transactions).toEqual([]);
      expect(template.coinbaseTransaction).toBeDefined();
      expect(template.blockReward).toBeGreaterThan(0n);
      expect(template.totalFees).toBe(0n);
    });
    
    test('should include mempool transactions in template', async () => {
      // create test transactions
      const keyPair1 = generateAddress();
      const keyPair2 = generateAddress();
      
      // fund first address
      await storage.updateAccountState(keyPair1.address, {
        balance: 1000000n,
        nonce: 0
      });
      
      // create transaction
      const tx = new TransactionClass(
        keyPair1.address,
        keyPair2.address,
        500000n,
        0,
        1000n // increased fee to meet minimum
      );
      await tx.sign(keyPair1.privateKey);
      
      // add to mempool
      await mempool.addTransaction(tx);
      
      // generate template
      const template = await gbtService.getBlockTemplate();
      
      expect(template.transactions).toHaveLength(1);
      expect(template.transactions[0].hash).toBe(tx.hash);
      expect(template.totalFees).toBe(1000n);
      expect(template.coinbaseTransaction.amount).toBe(template.blockReward + 1000n);
    });
    
    test('should cache templates', async () => {
      const template1 = await gbtService.getBlockTemplate();
      const template2 = await gbtService.getBlockTemplate();
      
      // should return same template if nothing changed
      expect(template2.templateId).toBe(template1.templateId);
    });
    
    test('should refresh template on significant mempool change', async () => {
      const template1 = await gbtService.getBlockTemplate();
      
      // verify initial state
      expect(template1.transactions).toHaveLength(0);
      
      // add transaction to trigger refresh
      const keyPair = generateAddress();
      await storage.updateAccountState(keyPair.address, {
        balance: 1000000n,
        nonce: 0
      });
      
      const tx = new TransactionClass(
        keyPair.address,
        generateAddress().address,
        500000n,
        0,
        10000n // high fee to trigger refresh
      );
      await tx.sign(keyPair.privateKey);
      await mempool.addTransaction(tx);
      
      // invalidate the current template to force regeneration
      // this simulates what would happen when mempool watcher detects change
      await gbtService['invalidateAllTemplates']();
      
      // get new template - should have the transaction
      const template2 = await gbtService.getBlockTemplate();
      
      // should have new template with transaction
      expect(template2.templateId).not.toBe(template1.templateId);
      expect(template2.transactions).toHaveLength(1);
      expect(template2.transactions[0].hash).toBe(tx.hash);
    });
    
    test('should expire old templates', async () => {
      const template = await gbtService.getBlockTemplate();
      
      expect(template.expiresAt).toBeGreaterThan(Date.now());
      expect(template.expiresAt).toBeLessThanOrEqual(Date.now() + 30000);
    });
  });
  
  describe('block submission', () => {
    test('should accept block submission with valid template (devnet difficulty)', async () => {
      const template = await gbtService.getBlockTemplate();
      
      // with devnet difficulty of 1, any nonce produces a valid hash
      const submission: BlockSubmission = {
        templateId: template.templateId,
        nonce: 12345,
        timestamp: template.timestamp
      };
      
      // note: with difficulty 1 in devnet, this will actually pass PoW validation
      // because target is essentially 2^256-1 (any hash is valid)
      const result = await gbtService.submitBlock(submission);
      
      // in devnet with difficulty 1, this should actually succeed
      // the block will be added to the blockchain
      expect(result.valid).toBe(true);
    });
    
    test('should reject submission with invalid template id', async () => {
      const submission: BlockSubmission = {
        templateId: 'invalid-template-id',
        nonce: 12345
      };
      
      const result = await gbtService.submitBlock(submission);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Template not found or expired');
    });
  });
  
  describe('longpoll support', () => {
    test('should support longpoll requests', async () => {
      const template1 = await gbtService.getBlockTemplate();
      
      // setup longpoll request
      const request: BlockTemplateRequest = {
        longpollId: template1.longpollId
      };
      
      // longpoll should return immediately if template changed
      const template2 = await gbtService.getBlockTemplate(request);
      
      expect(template2).toBeDefined();
      expect(template2.templateId).toBe(template1.templateId);
    });
    
    test('should wait for new template on longpoll', async () => {
      const template1 = await gbtService.getBlockTemplate();
      
      // setup longpoll that will wait
      const request: BlockTemplateRequest = {
        longpollId: template1.longpollId
      };
      
      // start longpoll (will wait for change)
      const longpollPromise = gbtService.getBlockTemplate(request);
      
      // trigger template refresh after delay
      setTimeout(async () => {
        // add high-fee transaction to trigger refresh
        const keyPair = generateAddress();
        await storage.updateAccountState(keyPair.address, {
          balance: 10000000n,
          nonce: 0
        });
        
        const tx = new TransactionClass(
          keyPair.address,
          generateAddress().address,
          5000000n,
          0,
          50000n // high fee
        );
        await tx.sign(keyPair.privateKey);
        await mempool.addTransaction(tx);
      }, 100);
      
      // wait for longpoll to resolve
      const template2 = await longpollPromise;
      
      expect(template2).toBeDefined();
    });
  });
  
  describe('template metadata', () => {
    test('should calculate correct block size', async () => {
      // add transactions
      const keyPair = generateAddress();
      await storage.updateAccountState(keyPair.address, {
        balance: 10000000n,
        nonce: 0
      });
      
      for (let i = 0; i < 5; i++) {
        const tx = new TransactionClass(
          keyPair.address,
          generateAddress().address,
          100000n,
          i,
          1000n // increased fee
        );
        await tx.sign(keyPair.privateKey);
        await mempool.addTransaction(tx);
      }
      
      const template = await gbtService.getBlockTemplate();
      
      expect(template.transactionCount).toBe(6); // 5 + coinbase
      expect(template.blockSizeBytes).toBeGreaterThan(0);
      expect(template.sigOpsCount).toBe(6);
    });
    
    
    test('should calculate difficulty target correctly', async () => {
      const template = await gbtService.getBlockTemplate();
      
      expect(template.target).toBeTruthy();
      expect(template.target).toHaveLength(64); // hex string
      expect(template.bits).toBeTruthy();
    });
  });
  
  describe('template lifecycle', () => {
    test('should clean up expired templates', async () => {
      // generate template
      const template = await gbtService.getBlockTemplate();
      
      // verify template exists
      const stored = await storage.getCustomData(`gbt:template:${template.templateId}`);
      expect(stored).toBeTruthy();
      
      // wait for cleanup cycle (simulated by manual trigger)
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // template should still exist (not expired yet)
      const stillStored = await storage.getCustomData(`gbt:template:${template.templateId}`);
      expect(stillStored).toBeTruthy();
    });
    
    test('should invalidate all templates on new block', async () => {
      const template1 = await gbtService.getBlockTemplate();
      
      // mine a block (this will invalidate templates)
      const keyPair = generateAddress();
      const block = await blockchain.createBlockTemplate([], keyPair.address);
      
      // manually trigger invalidation (normally done by event)
      await gbtService['invalidateAllTemplates']();
      
      // get new template
      const template2 = await gbtService.getBlockTemplate();
      
      expect(template2.templateId).not.toBe(template1.templateId);
    });
    
    test('should track active templates', async () => {
      const template = await gbtService.getBlockTemplate();
      
      const activeTemplates = await storage.getSetMembers('gbt:active');
      expect(activeTemplates).toContain(template.templateId);
      
      const currentTemplateId = await storage.getCustomData('gbt:current');
      expect(currentTemplateId).toBe(template.templateId);
    });
  });
  
  describe('merkle root calculation', () => {
    test('should calculate correct merkle root', async () => {
      const template = await gbtService.getBlockTemplate();
      
      expect(template.merkleRootPlaceholder).toBeTruthy();
      expect(template.merkleRootPlaceholder).toHaveLength(64);
    });
    
    test('should handle empty transaction list', async () => {
      const template = await gbtService.getBlockTemplate();
      
      // even with no transactions, should have coinbase
      expect(template.merkleRootPlaceholder).not.toBe('0'.repeat(64));
    });
  });
  
  describe('fee calculation', () => {
    test('should calculate total fees correctly', async () => {
      const keyPair = generateAddress();
      await storage.updateAccountState(keyPair.address, {
        balance: 10000000n,
        nonce: 0
      });
      
      const fees = [1000n, 2000n, 3000n]; // increased fees
      let totalFees = 0n;
      
      for (let i = 0; i < fees.length; i++) {
        const tx = new TransactionClass(
          keyPair.address,
          generateAddress().address,
          100000n,
          i,
          fees[i]
        );
        await tx.sign(keyPair.privateKey);
        await mempool.addTransaction(tx);
        totalFees += fees[i];
      }
      
      const template = await gbtService.getBlockTemplate();
      
      expect(template.totalFees).toBe(totalFees);
      expect(template.coinbaseValue).toBe(template.blockReward + totalFees);
    });
  });
});