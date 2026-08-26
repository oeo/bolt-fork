import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Block, Transaction } from '../../src/types';
import { StaleChainTipError, type StorageAdapter } from '../../src/storage/adapter';
import { LMDBAdapter } from '../../src/storage/lmdb-adapter';
import { MemoryAdapter } from '../../src/storage/memory';

const createBlock = (index: number, previousHash: string, hash: string): Block => ({
  index,
  previousHash,
  hash,
  timestamp: index + 1,
  merkleRoot: '1'.repeat(64),
  stateRoot: '2'.repeat(64),
  difficulty: 1,
  nonce: 0,
  transactions: [],
});

const genesis = createBlock(0, '0'.repeat(64), 'a'.repeat(64));
const firstBranch = createBlock(1, genesis.hash, 'b'.repeat(64));
const replacementBranch = createBlock(1, genesis.hash, 'c'.repeat(64));
const transaction: Transaction = {
  chainId: 1,
  kind: 'transfer',
  hash: 'd'.repeat(64),
  from: 'sender',
  to: 'recipient',
  amount: 2n,
  nonce: 0,
  fee: 1n,
  timestamp: 1,
};
const firstBranchWithTransaction = { ...firstBranch, transactions: [transaction] };

function canonicalTransitionContract(
  name: string,
  createStorage: () => Promise<{ storage: StorageAdapter; cleanup: () => Promise<void> }>
): void {
  describe(name, () => {
    let storage: StorageAdapter;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ storage, cleanup } = await createStorage());
      await storage.transitionCanonicalChain({
        expectedTip: { height: -1, hash: null },
        expectedCumulativeDifficulty: 0n,
        ancestor: { height: -1, hash: null },
        blocks: [genesis],
        accountStates: [{ address: 'canonical', state: { balance: 1n, nonce: 0 } }],
        cumulativeDifficulty: 1n,
      });
    });

    afterEach(async () => cleanup());

    test('rejects stale expected tips without changing canonical state', async () => {
      await expect(storage.transitionCanonicalChain({
        expectedTip: { height: 0, hash: 'f'.repeat(64) },
        expectedCumulativeDifficulty: 1n,
        ancestor: { height: 0, hash: genesis.hash },
        blocks: [firstBranch],
        accountStates: [{ address: 'changed', state: { balance: 2n, nonce: 0 } }],
        cumulativeDifficulty: 2n,
      })).rejects.toBeInstanceOf(StaleChainTipError);

      expect((await storage.getLatestBlock())?.hash).toBe(genesis.hash);
      expect(await storage.getBlockByHash(firstBranch.hash)).toBeNull();
      expect(await storage.getAccountState('canonical')).toEqual({ balance: 1n, nonce: 0 });
      expect(await storage.getCumulativeDifficulty()).toBe(1n);
    });

    test('atomically replaces blocks, indexes, accounts, and work', async () => {
      await storage.transitionCanonicalChain({
        expectedTip: { height: 0, hash: genesis.hash },
        expectedCumulativeDifficulty: 1n,
        ancestor: { height: 0, hash: genesis.hash },
        blocks: [firstBranch],
        accountStates: [{ address: 'detached', state: { balance: 2n, nonce: 0 } }],
        cumulativeDifficulty: 2n,
      });
      await storage.getBlock(1);
      await storage.getAccountState('detached');

      await storage.transitionCanonicalChain({
        expectedTip: { height: 1, hash: firstBranch.hash },
        expectedCumulativeDifficulty: 2n,
        ancestor: { height: 0, hash: genesis.hash },
        blocks: [replacementBranch],
        accountStates: [{ address: 'replacement', state: { balance: 3n, nonce: 1 } }],
        cumulativeDifficulty: 3n,
      });

      expect((await storage.getLatestBlock())?.hash).toBe(replacementBranch.hash);
      expect(await storage.getBlockByHash(firstBranch.hash)).toBeNull();
      expect((await storage.getBlockByHash(replacementBranch.hash))?.index).toBe(1);
      expect(await storage.getAccountState('detached')).toBeNull();
      expect(await storage.getAccountState('replacement')).toEqual({ balance: 3n, nonce: 1 });
      expect(await storage.getCumulativeDifficulty()).toBe(3n);
    });

    test('atomically updates confirmed indexes and mempool lifecycle', async () => {
      await storage.updateMempool({
        expectedTip: { height: 0, hash: genesis.hash },
        additions: [{ transaction, addedAt: 123 }],
        removals: [],
      });
      await storage.transitionCanonicalChain({
        expectedTip: { height: 0, hash: genesis.hash },
        expectedCumulativeDifficulty: 1n,
        ancestor: { height: 0, hash: genesis.hash },
        blocks: [firstBranchWithTransaction],
        accountStates: [],
        cumulativeDifficulty: 2n,
        mempoolAdditions: [],
        mempoolRemovals: [transaction.hash],
      });

      expect(await storage.getTransaction(transaction.hash)).toEqual(transaction);
      expect(await storage.getConfirmedTransaction(transaction.hash)).toEqual({
        transaction,
        blockHash: firstBranch.hash,
        blockHeight: 1,
        transactionIndex: 0,
        canonicalHeight: 1,
      });
      expect(await storage.getTransactionsByAddress('sender')).toEqual([transaction]);
      expect(await storage.getTransactionsByAddress('recipient')).toEqual([transaction]);
      expect(await storage.isInMempool(transaction.hash)).toBe(false);

      await storage.transitionCanonicalChain({
        expectedTip: { height: 1, hash: firstBranch.hash },
        expectedCumulativeDifficulty: 2n,
        ancestor: { height: 0, hash: genesis.hash },
        blocks: [replacementBranch],
        accountStates: [],
        cumulativeDifficulty: 3n,
        mempoolAdditions: [{ transaction, addedAt: 456 }],
        mempoolRemovals: [],
      });

      expect(await storage.getTransaction(transaction.hash)).toBeNull();
      expect(await storage.getConfirmedTransaction(transaction.hash)).toBeNull();
      expect(await storage.getTransactionsByAddress('sender')).toEqual([]);
      expect(await storage.getTransactionsByAddress('recipient')).toEqual([]);
      expect(await storage.getMempoolEntries()).toEqual([{ transaction, addedAt: 456 }]);
    });

    test('does not report a committed transition as failed when a listener throws', async () => {
      storage.onCanonicalMempoolUpdate(() => {
        throw new Error('listener failed');
      });

      await expect(storage.transitionCanonicalChain({
        expectedTip: { height: 0, hash: genesis.hash },
        expectedCumulativeDifficulty: 1n,
        ancestor: { height: 0, hash: genesis.hash },
        blocks: [firstBranch],
        accountStates: [],
        cumulativeDifficulty: 2n,
        mempoolAdditions: [],
        mempoolRemovals: [],
      })).resolves.toBeUndefined();
      expect((await storage.getLatestBlock())?.hash).toBe(firstBranch.hash);
    });

    test('rejects concurrent sender nonce conflicts in persistence', async () => {
      const conflicting = {
        ...transaction,
        hash: 'e'.repeat(64),
        to: 'other-recipient',
      };
      const results = await Promise.allSettled([
        storage.updateMempool({
          expectedTip: { height: 0, hash: genesis.hash },
          additions: [{ transaction, addedAt: 1 }],
          removals: [],
        }),
        storage.updateMempool({
          expectedTip: { height: 0, hash: genesis.hash },
          additions: [{ transaction: conflicting, addedAt: 2 }],
          removals: [],
        }),
      ]);

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(await storage.getMempoolEntries()).toHaveLength(1);
    });
  });
}

canonicalTransitionContract('memory canonical transition', async () => {
  const storage = new MemoryAdapter();
  await storage.connect();
  return { storage, cleanup: () => storage.close() };
});

canonicalTransitionContract('lmdb canonical transition', async () => {
  const path = join(tmpdir(), `bolt-transition-${randomUUID()}`);
  const storage = new LMDBAdapter({ path, mapSize: 10 * 1024 * 1024 });
  await storage.connect();
  return {
    storage,
    cleanup: async () => {
      await storage.close();
      await rm(path, { recursive: true, force: true });
    },
  };
});

describe('lmdb canonical transition rollback', () => {
  test('rolls back database writes and leaves warmed caches committed', async () => {
    const path = join(tmpdir(), `bolt-transition-${randomUUID()}`);
    const storage = new LMDBAdapter({ path, mapSize: 10 * 1024 * 1024 });
    await storage.connect();
    try {
      await storage.transitionCanonicalChain({
        expectedTip: { height: -1, hash: null },
        expectedCumulativeDifficulty: 0n,
        ancestor: { height: -1, hash: null },
        blocks: [genesis],
        accountStates: [{ address: 'canonical', state: { balance: 1n, nonce: 0 } }],
        cumulativeDifficulty: 1n,
      });
      await storage.getBlock(0);
      await storage.getAccountState('canonical');
      await storage.updateMempool({
        expectedTip: { height: 0, hash: genesis.hash },
        additions: [{ transaction, addedAt: 123 }],
        removals: [],
      });

      const manager = (storage as unknown as {
        manager: { metadata: { putSync: (key: string, value: unknown) => unknown } };
      }).manager;
      const putSync = manager.metadata.putSync.bind(manager.metadata);
      manager.metadata.putSync = (key, value) => {
        if (key === 'cumulativeDifficulty') throw new Error('injected late write failure');
        return putSync(key, value);
      };

      await expect(storage.transitionCanonicalChain({
        expectedTip: { height: 0, hash: genesis.hash },
        expectedCumulativeDifficulty: 1n,
        ancestor: { height: 0, hash: genesis.hash },
        blocks: [firstBranchWithTransaction],
        accountStates: [{ address: 'changed', state: { balance: 2n, nonce: 1 } }],
        cumulativeDifficulty: 2n,
        mempoolRemovals: [transaction.hash],
      })).rejects.toBeDefined();
      manager.metadata.putSync = putSync;

      expect((await storage.getLatestBlock())?.hash).toBe(genesis.hash);
      expect(await storage.getBlockByHash(firstBranch.hash)).toBeNull();
      expect(await storage.getAccountState('canonical')).toEqual({ balance: 1n, nonce: 0 });
      expect(await storage.getCumulativeDifficulty()).toBe(1n);
      expect(await storage.getTransaction(transaction.hash)).toBeNull();
      expect(await storage.isInMempool(transaction.hash)).toBe(true);

      await storage.close();
      const reopened = new LMDBAdapter({ path, mapSize: 10 * 1024 * 1024 });
      await reopened.connect();
      expect((await reopened.getLatestBlock())?.hash).toBe(genesis.hash);
      expect(await reopened.getBlockByHash(firstBranch.hash)).toBeNull();
      expect(await reopened.getAccountState('canonical')).toEqual({ balance: 1n, nonce: 0 });
      expect(await reopened.getTransaction(transaction.hash)).toBeNull();
      expect(await reopened.isInMempool(transaction.hash)).toBe(true);
      await reopened.close();
    } finally {
      await storage.close();
      await rm(path, { recursive: true, force: true });
    }
  });
});
