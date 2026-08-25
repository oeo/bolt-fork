import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Block } from '../../src/types';
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

      await expect(storage.transitionCanonicalChain({
        expectedTip: { height: 0, hash: genesis.hash },
        expectedCumulativeDifficulty: 1n,
        ancestor: { height: 0, hash: genesis.hash },
        blocks: [firstBranch],
        accountStates: [{
          address: 'invalid',
          state: { balance: 2n, nonce: 1n as unknown as number },
        }],
        cumulativeDifficulty: 2n,
      })).rejects.toBeDefined();

      expect((await storage.getLatestBlock())?.hash).toBe(genesis.hash);
      expect(await storage.getBlockByHash(firstBranch.hash)).toBeNull();
      expect(await storage.getAccountState('canonical')).toEqual({ balance: 1n, nonce: 0 });
      expect(await storage.getCumulativeDifficulty()).toBe(1n);

      await storage.close();
      const reopened = new LMDBAdapter({ path, mapSize: 10 * 1024 * 1024 });
      await reopened.connect();
      expect((await reopened.getLatestBlock())?.hash).toBe(genesis.hash);
      expect(await reopened.getBlockByHash(firstBranch.hash)).toBeNull();
      expect(await reopened.getAccountState('canonical')).toEqual({ balance: 1n, nonce: 0 });
      await reopened.close();
    } finally {
      await storage.close();
      await rm(path, { recursive: true, force: true });
    }
  });
});
