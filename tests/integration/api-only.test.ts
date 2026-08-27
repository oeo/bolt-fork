import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ApiServer } from '../../src/api/server';
import { Blockchain } from '../../src/core/blockchain';
import { Mempool } from '../../src/core/mempool';
import { createStorage } from '../../src/storage';
import { config as chainConfig } from '../../src/config/chain';
import { generateAddress } from '../../src/crypto/address';
import { TransactionClass } from '../../src/core/transaction';
import { serialize } from '../../src/utils/bigint';
import { GetBlockTemplateService } from '../../src/services/getblocktemplate';

describe('API Server Integration', () => {
  let apiServer: ApiServer;
  let blockchain: Blockchain;
  let mempool: Mempool;
  let storage: any;
  let blockTemplates: GetBlockTemplateService;
  const miningToken = 'test-mining-token';

  beforeAll(async () => {
    // create storage
    storage = createStorage('memory');

    // create blockchain
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();

    // create mempool
    mempool = new Mempool(storage, chainConfig);
    await mempool.initialize();
    blockTemplates = new GetBlockTemplateService(blockchain, mempool);

    // create api server WITHOUT p2p node
    apiServer = new ApiServer({
      port: 17333, // test port
      blockchain,
      mempool,
      storage,
      mining: {
        enabled: true,
        token: miningToken,
        service: blockTemplates,
        maxSubmissionsPerMinute: 2,
      },
      // note: no node provided
    });

    // start api server
    await apiServer.start();
  });

  afterAll(async () => {
    await apiServer.stop();
    await blockTemplates.shutdown();
    await storage.close();
  });

  test('should expose health endpoint', async () => {
    const response = await fetch('http://localhost:17333/health');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(data.timestamp).toBeDefined();
  });

  test('should get blockchain info', async () => {
    const response = await fetch('http://localhost:17333/blockchain/info');
    expect(response.status).toBe(200);
    const info = await response.json();
    
    expect(info.network).toBe(chainConfig.name);
    expect(info.height).toBe(0); // genesis only
    expect(info.difficulty).toBeDefined();
    expect(info.targetBlockTime).toBe(chainConfig.targetBlockTime);
    expect(info.maxSupply).toContain('BOLT');
    expect(info.currentReward).toContain('BOLT');
  });

  test('should get blocks', async () => {
    const response = await fetch('http://localhost:17333/blocks?limit=5');
    expect(response.status).toBe(200);
    const data = await response.json();
    
    expect(data.blocks).toBeInstanceOf(Array);
    expect(data.blocks.length).toBe(1); // only genesis
    expect(data.total).toBe(1);
    expect(data.limit).toBe(5);
    expect(data.offset).toBe(0);
  });

  test('should get specific block by height', async () => {
    const response = await fetch('http://localhost:17333/blocks/0');
    expect(response.status).toBe(200);
    const block = await response.json();
    
    expect(block.index).toBe(0);
    expect(block.previousHash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
    expect(block.transactions).toBeInstanceOf(Array);
  });

  test('should handle non-existent block', async () => {
    const response = await fetch('http://localhost:17333/blocks/999');
    expect(response.status).toBe(404);
    const error = await response.json();
    expect(error.error).toContain('Block not found');
  });

  test('should get mempool info', async () => {
    const response = await fetch('http://localhost:17333/mempool');
    expect(response.status).toBe(200);
    const mempoolInfo = await response.json();
    
    expect(mempoolInfo.size).toBe(0);
    expect(mempoolInfo.bytes).toBe(0);
    expect(mempoolInfo.minFeePerByte).toBeDefined();
    expect(mempoolInfo.totalFees).toBeDefined();
  });

  test('should submit valid transaction', async () => {
    // create test accounts
    const alice = generateAddress(chainConfig.addressPrefix);
    const bob = generateAddress(chainConfig.addressPrefix);
    
    // give alice some balance
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n, // 100 BOLT
      nonce: 0
    });

    // create transaction (from, to, amount, nonce, fee, timestamp)
    const tx = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      bob.address,
      1_000_000_000n, // 10 BOLT amount
      0, // nonce
      1_000_000n, // 0.01 BOLT fee
      Date.now()
    );
    await tx.sign(alice.privateKey);

    // submit via API
    const response = await fetch('http://localhost:17333/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialize(tx.toObject())
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.accepted).toBe(true);
    expect(result.hash).toBe(tx.hash);
    expect(result.broadcasted).toBeUndefined();

    // verify in mempool
    const mempoolTx = mempool.getTransaction(tx.hash);
    expect(mempoolTx).toBeDefined();
    expect(mempoolTx?.hash).toBe(tx.hash);
  });

  test('should reject invalid transaction', async () => {
    const alice = generateAddress(chainConfig.addressPrefix);
    const bob = generateAddress(chainConfig.addressPrefix);
    
    // alice has no balance
    const tx = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      bob.address,
      1_000_000_000n, // amount
      0, // nonce
      1_000_000n, // fee
      Date.now()
    );
    await tx.sign(alice.privateKey);

    const response = await fetch('http://localhost:17333/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialize(tx.toObject())
    });

    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.error).toBe('Transaction rejected');
  });

  test('should get account balance', async () => {
    const alice = generateAddress(chainConfig.addressPrefix);
    
    await storage.updateAccountState(alice.address, {
      balance: 5_000_000_000n, // 50 BOLT
      nonce: 2
    });

    const response = await fetch(`http://localhost:17333/accounts/${alice.address}/balance`);
    expect(response.status).toBe(200);
    const data = await response.json();
    
    expect(data.address).toBe(alice.address);
    expect(data.balance).toBe('5000000000n');
    expect(data.formatted).toBe('50 BOLT');
  });

  test('should get account nonce', async () => {
    const alice = generateAddress(chainConfig.addressPrefix);
    
    await storage.updateAccountState(alice.address, {
      balance: 1_000_000_000n,
      nonce: 5
    });

    const response = await fetch(`http://localhost:17333/accounts/${alice.address}/nonce`);
    expect(response.status).toBe(200);
    const data = await response.json();
    
    expect(data.address).toBe(alice.address);
    expect(data.nonce).toBe(5);
  });

  test('should get transaction by hash', async () => {
    // add a transaction to mempool
    const alice = generateAddress(chainConfig.addressPrefix);
    const bob = generateAddress(chainConfig.addressPrefix);
    
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n,
      nonce: 0
    });

    const tx = new TransactionClass(
      chainConfig.chainId,
      alice.address,
      bob.address,
      100_000_000n, // 1 BOLT amount
      0, // nonce
      100_000n, // fee
      Date.now()
    );
    await tx.sign(alice.privateKey);
    
    await mempool.addTransaction(tx.toObject());

    const response = await fetch(`http://localhost:17333/transactions/${tx.hash}`);
    expect(response.status).toBe(200);
    const data = await response.json();
    
    expect(data.hash).toBe(tx.hash);
    expect(data.status).toBe('pending');
    expect(data.confirmations).toBe(0);
  });

  test('returns a confirmed transaction from one storage snapshot', async () => {
    const hash = '12'.repeat(32);
    const blockHash = '34'.repeat(32);
    const getConfirmedTransaction = storage.getConfirmedTransaction;
    storage.getConfirmedTransaction = async () => ({
      transaction: { hash },
      blockHeight: 2,
      blockHash,
      canonicalHeight: 4,
    });

    try {
      const response = await fetch(`http://localhost:17333/transactions/${hash}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        hash,
        status: 'confirmed',
        confirmations: 3,
        blockHeight: 2,
        blockHash,
      });
    } finally {
      storage.getConfirmedTransaction = getConfirmedTransaction;
    }
  });

  test('does not enable browser cross-origin access', async () => {
    const response = await fetch('http://localhost:17333/health');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  test('rejects unsupported methods', async () => {
    const response = await fetch('http://localhost:17333/health', {
      method: 'OPTIONS'
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('should return 404 for unknown endpoints', async () => {
    const response = await fetch('http://localhost:17333/unknown');
    expect(response.status).toBe(404);
    const error = await response.json();
    expect(error.error).toBe('Endpoint not found');
  });

  test('does not expose network control or synchronization endpoints', async () => {
    for (const path of [
      '/network/status',
      '/peers',
      '/peers/connect',
      '/peer/status',
      '/peer/blocks',
      '/peer/transactions',
    ]) {
      const response = await fetch(`http://localhost:17333${path}`);
      expect(response.status).toBe(404);
    }
    for (const path of ['/peers/connect', '/peer/blocks', '/peer/transactions']) {
      const response = await fetch(`http://localhost:17333${path}`, { method: 'POST' });
      expect(response.status).toBe(404);
    }
  });

  test('validates and bounds pagination', async () => {
    for (const query of ['limit=0', 'limit=101', 'limit=1x', 'offset=-1', 'offset=1.5', 'limit=1&limit=2', 'other=1']) {
      const response = await fetch(`http://localhost:17333/blocks?${query}`);
      expect(response.status).toBe(400);
    }

    const response = await fetch('http://localhost:17333/blocks?limit=1&offset=5');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ blocks: [], count: 0, limit: 1, offset: 5 });
  });

  test('paginates mempool transactions', async () => {
    const response = await fetch('http://localhost:17333/mempool/transactions?limit=1&offset=0');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ limit: 1, offset: 0, count: 1 });
  });

  test('validates path parameters', async () => {
    for (const path of [
      '/blocks/not-a-hash',
      `/blocks/${'A'.repeat(64)}`,
      `/transactions/${'z'.repeat(64)}`,
      `/transactions/${'A'.repeat(64)}`,
      '/accounts/not-an-address/balance',
      '/accounts/not-an-address/nonce',
    ]) {
      const response = await fetch(`http://localhost:17333${path}`);
      expect(response.status).toBe(400);
    }
    expect((await fetch('http://localhost:17333/blocks/999')).status).toBe(404);
    expect((await fetch(`http://localhost:17333/transactions/${'0'.repeat(64)}`)).status).toBe(404);
  });

  test('requires bounded JSON transaction bodies', async () => {
    const missingType = await fetch('http://localhost:17333/transactions', {
      method: 'POST',
      body: '{}',
    });
    expect(missingType.status).toBe(415);

    const malformed = await fetch('http://localhost:17333/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch('http://localhost:17333/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(128 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });

  test('authenticates and bounds mining routes', async () => {
    const payoutAddress = generateAddress(chainConfig.addressPrefix).address;
    const unauthorized = await fetch('http://localhost:17333/mining/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payoutAddress }),
    });
    expect(unauthorized.status).toBe(401);

    const invalidPayout = await fetch('http://localhost:17333/mining/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miningToken}` },
      body: JSON.stringify({ payoutAddress: 'invalid' }),
    });
    expect(invalidPayout.status).toBe(400);

    const response = await fetch('http://localhost:17333/mining/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miningToken}` },
      body: JSON.stringify({ payoutAddress }),
    });
    expect(response.status).toBe(200);
    const template = await response.json();
    expect(template.coinbaseTransaction.to).toBe(payoutAddress);

    const malformed = await fetch('http://localhost:17333/mining/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miningToken}` },
      body: JSON.stringify({ templateId: template.templateId, nonce: -1 }),
    });
    expect(malformed.status).toBe(400);
  });

  test('keeps mining routes disabled without explicit configuration', () => {
    expect(() => new ApiServer({
      blockchain,
      mempool,
      storage,
      mining: { enabled: true, service: blockTemplates },
    })).toThrow('token');
  });

  test('returns not found for mining routes when disabled', async () => {
    const disabled = new ApiServer({ blockchain, mempool, storage });
    const response = await disabled['handleRequest'](new Request('http://localhost/mining/template', {
      method: 'POST',
    }));
    expect(response.status).toBe(404);
  });
});
