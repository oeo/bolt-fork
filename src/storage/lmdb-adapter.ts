import {
  CanonicalTransition,
  type AccountChange,
  ConfirmedTransactionSnapshot,
  MempoolUpdate,
  PersistedMempoolEntry,
  StaleChainTipError,
  StorageAdapter,
} from './adapter';
import { LMDBManager } from './lmdb-manager';
import { LMDBBlockchainStore } from './lmdb-blockchain-store';
import { LMDBStateStore } from './lmdb-state-store';
import { LMDBMempoolStore } from './lmdb-mempool-store';
import type { Block, Transaction, AccountState } from '../types';
import { getLogger } from '../utils/logger';
import { deserializeBigInt, serializeBigInt } from '../utils/serialization';

const logger = getLogger(__filename);

interface ConfirmedTransactionRecord {
  transaction: Transaction;
  blockHash: string;
  blockHeight: number;
  transactionIndex: number;
}

/**
 * composite lmdb adapter that implements the full StorageAdapter interface
 * delegates to specialized stores for different data types
 */
export class LMDBAdapter extends StorageAdapter {
  private manager: LMDBManager;
  private blockchainStore: LMDBBlockchainStore;
  private stateStore: LMDBStateStore;
  private mempoolStore: LMDBMempoolStore;
  constructor(config: { path: string; mapSize?: number }) {
    super();
    this.manager = new LMDBManager(config);
    this.blockchainStore = new LMDBBlockchainStore(this.manager);
    this.stateStore = new LMDBStateStore(this.manager);
    this.mempoolStore = new LMDBMempoolStore(this.manager);
  }

  async connect(): Promise<void> {
    // lmdb manager opens databases in constructor
    this.isConnected = true;
    logger.info('lmdb storage connected');
  }

  async close(): Promise<void> {
    await this.manager.close();
    this.isConnected = false;
  }

  async clear(): Promise<void> {
    await this.manager.clearAll();
  }

  async getStorageStats(): Promise<{ used: number; keys: number; type: string }> {
    const stats = await this.manager.getStats();
    return {
      type: 'lmdb',
      used: 0,
      keys: Object.values(stats.databases as Record<string, number>).reduce((sum, count) => sum + count, 0),
    };
  }

  // blockchain operations
  async addBlock(block: Block): Promise<void> {
    return this.blockchainStore.addBlock(block);
  }

  async saveBlock(block: Block): Promise<void> {
    return this.blockchainStore.addBlock(block);
  }

  async transitionCanonicalChain({
    expectedTip,
    expectedCumulativeDifficulty,
    ancestor,
    blocks,
    accountChanges,
    cumulativeDifficulty,
    mempoolAdditions = [],
    mempoolRemovals = [],
  }: CanonicalTransition): Promise<void> {
    if (cumulativeDifficulty < 0n) throw new Error('Invalid cumulative difficulty');
    if (accountChanges.length !== blocks.length || accountChanges.some((entry, index) =>
      entry.blockHash !== blocks[index].hash ||
      new Set(entry.changes.map(change => change.address)).size !== entry.changes.length
    )) throw new Error('Invalid canonical account changes');
    this.manager.transactionSync(() => {
      const storedHeight = this.manager.metadata.get('chainHeight');
      const storedHash = this.manager.metadata.get('chainTip');
      const actualTip = {
        height: storedHeight === undefined ? -1 : Number(storedHeight.toString()),
        hash: storedHash === undefined ? null : storedHash.toString(),
      };
      const storedDifficulty = this.manager.metadata.get('cumulativeDifficulty');
      const actualDifficulty = storedDifficulty === undefined ? 0n : BigInt(storedDifficulty.toString());
      if (
        actualTip.height !== expectedTip.height ||
        actualTip.hash !== expectedTip.hash ||
        actualDifficulty !== expectedCumulativeDifficulty
      ) {
        throw new StaleChainTipError(actualTip);
      }

      const ancestorBlock = ancestor.height >= 0 ? this.blockchainStore.readBlock(ancestor.height) : null;
      const ancestorMatches = ancestor.height === -1
        ? ancestor.hash === null
        : ancestorBlock?.hash === ancestor.hash;
      if (ancestor.height < -1 || ancestor.height > expectedTip.height || !ancestorMatches) {
        throw new Error('Invalid canonical ancestor');
      }

      let previousHash = ancestor.hash;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (block.index !== ancestor.height + i + 1 || block.previousHash !== (previousHash ?? '0'.repeat(64))) {
          throw new Error('Invalid replacement chain');
        }
        previousHash = block.hash;
      }

      const detachedBlocks: Block[] = [];
      for (let height = ancestor.height + 1; height <= expectedTip.height; height++) {
        const detached = this.blockchainStore.readBlock(height);
        if (detached) detachedBlocks.push(detached);
      }
      for (const block of detachedBlocks.reverse()) {
        const undo = this.readAccountChanges(block.hash);
        if (!undo) throw new Error(`Missing account undo for block ${block.hash}`);
        this.stateStore.writeChanges(undo.map(({ address, previous }) => ({
          address,
          previous: null,
          state: previous,
        })));
        this.manager.accountChanges.removeSync(block.hash);
      }
      for (const block of detachedBlocks) this.writeRemoveConfirmedTransactions(block);
      this.blockchainStore.writeRemoveBlocksAbove(ancestor.height);
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const entry = accountChanges[index];
        for (const { address, previous } of entry.changes) {
          if (!this.statesEqual(this.stateStore.readAccount(address), previous)) {
            throw new Error(`Account undo mismatch: ${address}`);
          }
        }
        this.stateStore.writeChanges(entry.changes);
        this.manager.accountChanges.putSync(block.hash, this.serializeAccountChanges(entry.changes));
        this.blockchainStore.writeBlock(block);
        this.writeConfirmedTransactions(block);
      }
      this.mempoolStore.writeUpdate(mempoolAdditions, mempoolRemovals);
      this.manager.metadata.putSync('cumulativeDifficulty', cumulativeDifficulty.toString());
    });
    for (const error of this.publishCanonicalMempoolUpdate(mempoolAdditions, mempoolRemovals)) {
      logger.error('Canonical mempool listener failed', error);
    }
  }

  async getBlock(index: number): Promise<Block | null> {
    return this.blockchainStore.getBlock(index);
  }

  async getBlockByHash(hash: string): Promise<Block | null> {
    return this.blockchainStore.getBlockByHash(hash);
  }

  async getLatestBlock(): Promise<Block | null> {
    return this.blockchainStore.getLatestBlock();
  }

  async getBlockRange(start: number, end: number): Promise<Block[]> {
    return this.blockchainStore.getBlockRange(start, end);
  }

  async getChainHeight(): Promise<number> {
    return this.blockchainStore.getHeight();
  }

  async hasBlock(hash: string): Promise<boolean> {
    return this.blockchainStore.hasBlock(hash);
  }

  async getAllAccountAddresses(): Promise<string[]> {
    return this.stateStore.getAllAccountAddresses();
  }

  async getCumulativeDifficulty(): Promise<bigint> {
    const metadata = await this.manager.metadata.get('cumulativeDifficulty');
    return metadata ? BigInt(metadata) : 0n;
  }

  async getChainTip(): Promise<string | null> {
    const latest = await this.getLatestBlock();
    return latest ? latest.hash : null;
  }

  // state operations
  async getAccountState(address: string): Promise<AccountState | null> {
    return this.stateStore.getAccountState(address);
  }

  async getAccountStates(addresses: Iterable<string>, ancestor: { height: number; hash: string | null }): Promise<Map<string, AccountState>> {
    return this.manager.transactionSync(() => {
      const ancestorBlock = ancestor.height >= 0 ? this.blockchainStore.readBlock(ancestor.height) : null;
      if (ancestor.height < -1 || (ancestor.height === -1 ? ancestor.hash !== null : ancestorBlock?.hash !== ancestor.hash)) {
        throw new Error('Invalid canonical ancestor');
      }
      const heightValue = this.manager.metadata.get('chainHeight');
      const height = heightValue === undefined ? -1 : Number(heightValue.toString());
      const requested = new Set(addresses);
      const states = new Map<string, AccountState>();
      for (const address of requested) {
        const account = this.stateStore.readAccount(address);
        if (account) states.set(address, { balance: account.balance, nonce: account.nonce });
      }
      for (let index = height; index > ancestor.height; index--) {
        const block = this.blockchainStore.readBlock(index);
        const undo = block && this.readAccountChanges(block.hash);
        if (!undo) throw new Error(`Missing account undo at height ${index}`);
        for (const { address, previous } of undo) {
          if (!requested.has(address)) continue;
          if (previous) states.set(address, { ...previous });
          else states.delete(address);
        }
      }
      return states;
    });
  }

  async getAccountChanges(blockHash: string): Promise<AccountChange[] | null> {
    return this.readAccountChanges(blockHash);
  }

  async updateAccountState(address: string, state: AccountState): Promise<void> {
    return this.stateStore.updateAccountState(address, state);
  }

  // mempool operations
  async addToMempool(tx: Transaction): Promise<void> {
    await this.mempoolStore.addTransaction(tx);
  }

  async getTransaction(hash: string): Promise<Transaction | null> {
    return (await this.getConfirmedTransaction(hash))?.transaction ?? null;
  }

  async getConfirmedTransaction(hash: string): Promise<ConfirmedTransactionSnapshot | null> {
    return this.manager.transactionSync(() => {
      const data = this.manager.confirmedTransactions.get(hash);
      if (!data) return null;
      const height = this.manager.metadata.get('chainHeight');
      return {
        ...this.deserializeConfirmedTransaction(data),
        canonicalHeight: height === undefined ? -1 : Number(height.toString()),
      };
    });
  }

  async getMempoolTransactions(): Promise<Transaction[]> {
    return this.mempoolStore.getTransactions();
  }

  async getMempoolEntries(): Promise<PersistedMempoolEntry[]> {
    return this.mempoolStore.getEntries();
  }

  async getMempoolAdmissionState(address: string) {
    return this.manager.transactionSync(() => {
      const height = this.manager.metadata.get('chainHeight');
      const tip = this.manager.metadata.get('chainTip');
      const account = this.stateStore.readAccount(address);
      return {
        tip: {
          height: height === undefined ? -1 : Number(height.toString()),
          hash: tip === undefined ? null : tip.toString(),
        },
        accountState: account ? { balance: account.balance, nonce: account.nonce } : null,
      };
    });
  }

  async updateMempool({ expectedTip, additions, removals }: MempoolUpdate): Promise<void> {
    this.manager.transactionSync(() => {
      const height = this.manager.metadata.get('chainHeight');
      const tip = this.manager.metadata.get('chainTip');
      const actualTip = {
        height: height === undefined ? -1 : Number(height.toString()),
        hash: tip === undefined ? null : tip.toString(),
      };
      if (actualTip.height !== expectedTip.height || actualTip.hash !== expectedTip.hash) {
        throw new StaleChainTipError(actualTip);
      }
      const removed = new Set(removals);
      const pendingNonces = new Set<string>();
      for (const entry of additions) {
        if (!removed.has(entry.transaction.hash) && this.manager.mempool.get(entry.transaction.hash)) {
          throw new Error(`Transaction ${entry.transaction.hash} already in storage mempool`);
        }
        const sender = entry.transaction.from;
        if (!sender) continue;
        const nonceKey = `${sender}:${entry.transaction.nonce}`;
        if (pendingNonces.has(nonceKey)) {
          throw new Error(`Nonce ${entry.transaction.nonce} already in storage mempool`);
        }
        pendingNonces.add(nonceKey);
        for (const { value } of this.manager.mempoolByAddress.getRange({
          start: `${sender}:`,
          end: `${sender}:\xff`,
        })) {
          const hash = value.toString();
          if (removed.has(hash)) continue;
          const existing = this.mempoolStore.readEntry(hash);
          if (existing?.transaction.from === sender && existing.transaction.nonce === entry.transaction.nonce) {
            throw new Error(`Nonce ${entry.transaction.nonce} already in storage mempool`);
          }
        }
      }
      this.mempoolStore.writeUpdate(additions, removals);
    });
  }

  async removeFromMempool(hash: string): Promise<void> {
    return this.mempoolStore.removeTransaction(hash);
  }

  async hasTransaction(hash: string): Promise<boolean> {
    return this.mempoolStore.hasTransaction(hash);
  }

  async clearMempool(): Promise<void> {
    return this.mempoolStore.clear();
  }

  async getTransactionsByAddress(address: string): Promise<Transaction[]> {
    const transactions: Transaction[] = [];
    for (const { value } of this.manager.confirmedByAddress.getRange({
      start: `${address}:`,
      end: `${address}:\xff`,
    })) {
      const data = this.manager.confirmedTransactions.get(value.toString());
      if (data) transactions.push(this.deserializeConfirmedTransaction(data).transaction);
    }
    return transactions;
  }

  // transaction persistence (for blockchain)
  async isInMempool(txHash: string): Promise<boolean> {
    return this.mempoolStore.hasTransaction(txHash);
  }

  async saveChainMetadata(key: string, value: any): Promise<void> {
    await this.manager.metadata.put(`chain:${key}`, value);
  }

  async getChainMetadata(key: string): Promise<any> {
    return this.manager.metadata.get(`chain:${key}`) ?? null;
  }

  async setCustomData(key: string, value: string, _ttl?: number): Promise<void> {
    await this.manager.metadata.put(`custom:${key}`, value);
  }

  async getCustomData(key: string): Promise<string | null> {
    return (await this.manager.metadata.get(`custom:${key}`)) ?? null;
  }

  async deleteCustomData(key: string): Promise<void> {
    await this.manager.metadata.remove(`custom:${key}`);
  }

  async addToSet(key: string, value: string): Promise<void> {
    const values = await this.getSetMembers(key);
    if (!values.includes(value)) values.push(value);
    await this.manager.metadata.put(`set:${key}`, JSON.stringify(values));
  }

  async removeFromSet(key: string, value: string): Promise<void> {
    const values = (await this.getSetMembers(key)).filter(item => item !== value);
    await this.manager.metadata.put(`set:${key}`, JSON.stringify(values));
  }

  async getSetMembers(key: string): Promise<string[]> {
    const raw = await this.manager.metadata.get(`set:${key}`);
    return raw ? JSON.parse(raw) : [];
  }

  private writeConfirmedTransactions(block: Block): void {
    block.transactions.forEach((transaction, transactionIndex) => {
      if (this.manager.confirmedTransactions.get(transaction.hash)) {
        throw new Error(`Duplicate confirmed transaction: ${transaction.hash}`);
      }
      const record: ConfirmedTransactionRecord = {
        transaction,
        blockHash: block.hash,
        blockHeight: block.index,
        transactionIndex,
      };
      this.manager.confirmedTransactions.putSync(
        transaction.hash,
        this.serializeConfirmedTransaction(record)
      );
      if (transaction.from) {
        this.manager.confirmedByAddress.putSync(
          `${transaction.from}:${transaction.hash}`,
          transaction.hash
        );
      }
      this.manager.confirmedByAddress.putSync(
        `${transaction.to}:${transaction.hash}`,
        transaction.hash
      );
    });
  }

  private writeRemoveConfirmedTransactions(block: Block): void {
    for (const transaction of block.transactions) {
      const data = this.manager.confirmedTransactions.get(transaction.hash);
      if (!data) continue;
      const record = this.deserializeConfirmedTransaction(data);
      if (record.blockHash !== block.hash) continue;
      this.manager.confirmedTransactions.removeSync(transaction.hash);
      if (transaction.from) {
        this.manager.confirmedByAddress.removeSync(`${transaction.from}:${transaction.hash}`);
      }
      this.manager.confirmedByAddress.removeSync(`${transaction.to}:${transaction.hash}`);
    }
  }

  private serializeConfirmedTransaction(record: ConfirmedTransactionRecord): Buffer {
    return Buffer.from(JSON.stringify({
      ...record,
      transaction: {
        ...record.transaction,
        amount: serializeBigInt(record.transaction.amount),
        fee: serializeBigInt(record.transaction.fee),
      },
    }));
  }

  private deserializeConfirmedTransaction(data: Buffer): ConfirmedTransactionRecord {
    const record = JSON.parse(data.toString());
    return {
      ...record,
      transaction: {
        ...record.transaction,
        amount: deserializeBigInt(record.transaction.amount),
        fee: deserializeBigInt(record.transaction.fee),
      },
    };
  }

  private serializeAccountChanges(changes: readonly AccountChange[]): Buffer {
    return Buffer.from(JSON.stringify(changes, (_, value) => typeof value === 'bigint' ? value.toString() : value));
  }

  private readAccountChanges(blockHash: string): AccountChange[] | null {
    const data = this.manager.accountChanges.get(blockHash);
    if (!data) return null;
    return JSON.parse(data.toString(), (key, value) => key === 'balance' ? BigInt(value) : value);
  }

  private statesEqual(account: { balance: bigint; nonce: number } | null, state: AccountState | null): boolean {
    return account?.balance === state?.balance && account?.nonce === state?.nonce;
  }

  // utility operations
  async getStats(): Promise<any> {
    return this.manager.getStats();
  }
}
