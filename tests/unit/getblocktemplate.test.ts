import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GetBlockTemplateService } from '../../src/services/getblocktemplate';
import { Blockchain } from '../../src/core/blockchain';
import { Mempool } from '../../src/core/mempool';
import { MemoryAdapter } from '../../src/storage/memory';
import { devnet } from '../../src/config/chains/devnet';
import { generateAddress } from '../../src/crypto/address';
import { createSignedTransaction } from '../../src/core/transaction';
import type { BlockTemplate } from '../../src/types';
import type { ChainConfig } from '../../src/config/chain';

describe('GetBlockTemplateService', () => {
  let storage: MemoryAdapter;
  let blockchain: Blockchain;
  let mempool: Mempool;
  let service: GetBlockTemplateService;
  let payoutAddress: string;
  let chainConfig: ChainConfig;

  beforeEach(async () => {
    storage = new MemoryAdapter();
    chainConfig = { ...devnet };
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    mempool = new Mempool(storage, devnet);
    await mempool.initialize();
    service = new GetBlockTemplateService(blockchain, mempool);
    payoutAddress = generateAddress(devnet.addressPrefix).address;
  });

  afterEach(async () => {
    await service.shutdown();
    await blockchain.close();
  });

  const getTemplate = () => service.getBlockTemplate({ payoutAddress });
  const reconstruct = (template: BlockTemplate, nonce = 0) => service['reconstructBlock'](template, {
    templateId: template.templateId,
    nonce,
    timestamp: template.timestamp,
  });

  test('builds exact prepared candidate and caches it by payout', async () => {
    const template = await getTemplate();
    const second = await getTemplate();
    const block = reconstruct(template, Number.MAX_SAFE_INTEGER);
    block.hash = 'f'.repeat(64);

    expect(second.templateId).toBe(template.templateId);
    expect(template.height).toBe(1);
    expect(template.merkleRootPlaceholder).toBe(block.merkleRoot);
    expect(template.stateRoot).toBe(block.stateRoot);
    expect(template.blockSizeBytes).toBe(block.getSize());
    expect(template.coinbaseValue).toBe(template.blockReward + template.totalFees);
  });

  test('includes nonce-dependent mempool transactions and fees', async () => {
    const sender = generateAddress(devnet.addressPrefix);
    await storage.updateAccountState(sender.address, { balance: 1_000_000n, nonce: 0 });
    const transactions = await Promise.all([0, 1].map(nonce => createSignedTransaction(
      devnet.chainId,
      sender.address,
      payoutAddress,
      100_000n,
      nonce,
      1000n + BigInt(nonce),
      sender.privateKey
    )));
    for (const transaction of transactions) await mempool.addTransaction(transaction);

    const template = await getTemplate();

    expect(template.transactions.map(transaction => transaction.hash)).toEqual(
      transactions.map(transaction => transaction.hash)
    );
    expect(template.totalFees).toBe(2001n);
    expect(template.transactionCount).toBe(3);
  });

  test('trims only selection suffix and recomputes exact commitments', async () => {
    const sender = generateAddress(devnet.addressPrefix);
    await storage.updateAccountState(sender.address, { balance: 2_000_000n, nonce: 0 });
    for (let nonce = 0; nonce < 2; nonce++) {
      await mempool.addTransaction(await createSignedTransaction(
        devnet.chainId,
        sender.address,
        payoutAddress,
        100_000n,
        nonce,
        2000n,
        sender.privateKey
      ));
    }
    const full = await getTemplate();
    chainConfig.maxBlockSize = full.blockSizeBytes - 1;
    const trimmed = await service.getBlockTemplate({
      payoutAddress: generateAddress(devnet.addressPrefix).address,
    });
    const block = reconstruct(trimmed, Number.MAX_SAFE_INTEGER);
    block.hash = 'f'.repeat(64);

    expect(trimmed.transactions).toEqual(full.transactions.slice(0, trimmed.transactions.length));
    expect(trimmed.transactions.length).toBeLessThan(full.transactions.length);
    expect(trimmed.blockSizeBytes).toBe(block.getSize());
    expect(trimmed.blockSizeBytes).toBeLessThanOrEqual(chainConfig.maxBlockSize);
    expect(trimmed.coinbaseValue).toBe(trimmed.blockReward + trimmed.totalFees);
  });

  test('rejects payout addresses from another network', async () => {
    await expect(service.getBlockTemplate({
      payoutAddress: generateAddress(0x00).address,
    })).rejects.toThrow('Invalid payout address');
  });

  test('bounds jobs in memory', async () => {
    for (let index = 0; index < 12; index++) {
      await service.getBlockTemplate({ payoutAddress: generateAddress(devnet.addressPrefix).address });
    }
    expect(service['jobs'].size).toBe(10);
  });

  test('accepts valid work and rejects malformed submissions', async () => {
    const template = await getTemplate();
    expect((await service.submitBlock({ templateId: template.templateId, nonce: 0 })).valid).toBe(true);
    expect((await service.submitBlock({ templateId: 'bad', nonce: 0 })).error).toContain('Invalid');
    expect((await service.submitBlock({ templateId: template.templateId, nonce: -1 })).valid).toBe(false);
  });

  test('first longpoll use returns, repeated use wakes on chain change', async () => {
    const template = await getTemplate();
    expect((await service.getBlockTemplate({ payoutAddress, longpollId: template.longpollId })).templateId)
      .toBe(template.templateId);
    const waiting = service.getBlockTemplate({ payoutAddress, longpollId: template.longpollId });
    while (service['subscriptions'].size === 0) await Promise.resolve();

    expect((await service.submitBlock({ templateId: template.templateId, nonce: 0 })).valid).toBe(true);
    const refreshed = await waiting;

    expect(refreshed.height).toBe(2);
    expect(refreshed.previousHash).toBe(reconstruct(template).hash);
  });
});
