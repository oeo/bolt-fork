import type { AccountState, Block } from '../types';
import type { ChainConfig } from '../config/chain';
import { hash } from '../crypto/hash';
import { encodeCanonicalFields } from '../utils/serialization';
import { TransactionClass, validateTransactionPool } from './transaction';
import type { AccountChange } from '../storage/adapter';

export interface BlockExecution {
  accountStates: Map<string, AccountState>;
  updates: AccountChange[];
  stateRoot: string;
}

export const EMPTY_STATE_ROOT_PARENT = '0'.repeat(64);

export function calculateStateRoot(parentStateRoot: string, updates: readonly AccountChange[]): string {
  const fields: string[] = ['bolt:state-transition:v1', parentStateRoot];
  for (const { address, state } of [...updates].sort((a, b) => a.address.localeCompare(b.address))) {
    fields.push(
      address,
      (state?.balance ?? 0n).toString(),
      (state?.nonce ?? 0).toString(),
      state ? '0' : '1'
    );
  }
  return hash(encodeCanonicalFields(fields), 'sha256');
}

export async function executeBlock(
  block: Block,
  currentStates: ReadonlyMap<string, AccountState>,
  parentStateRoot: string,
  config: ChainConfig,
  blockReward: bigint
): Promise<BlockExecution> {
  const transactions = block.transactions.map(transaction => TransactionClass.fromObject(transaction));
  if (transactions.length === 0 || !transactions[0].isCoinbase()) {
    throw new Error('Coinbase transaction must be first');
  }
  if (transactions.slice(1).some(transaction => transaction.isCoinbase())) {
    throw new Error('Only first transaction may be coinbase');
  }

  const poolValidation = validateTransactionPool(transactions);
  if (!poolValidation.valid) throw new Error(poolValidation.error);

  const fees = transactions.slice(1).reduce((total, transaction) => total + transaction.fee, 0n);
  const coinbase = transactions[0];
  if (
    coinbase.amount !== blockReward + fees ||
    coinbase.fee !== 0n ||
    coinbase.nonce !== 0 ||
    coinbase.timestamp !== block.timestamp
  ) {
    throw new Error('Invalid coinbase transaction');
  }

  const accountStates = new Map<string, AccountState>();
  const previousStates = new Map<string, AccountState | null>();
  const getState = (address: string): AccountState => {
    const existing = accountStates.get(address);
    if (existing) return existing;
    const previous = currentStates.get(address);
    previousStates.set(address, previous ? { ...previous } : null);
    const state = previous ? { ...previous } : { balance: 0n, nonce: 0 };
    accountStates.set(address, state);
    return state;
  };

  for (const transaction of transactions) {
    const validation = transaction.validate(config.chainId, config.addressPrefix, block.timestamp);
    if (!validation.valid) throw new Error(`Transaction ${transaction.hash}: ${validation.error}`);
    if (!transaction.isCoinbase() && !(await transaction.verify())) {
      throw new Error(`Transaction ${transaction.hash}: Invalid signature`);
    }

    if (transaction.isCoinbase()) {
      getState(transaction.to).balance += transaction.amount;
      continue;
    }
    if (!currentStates.has(transaction.from!)) {
      throw new Error(`Transaction ${transaction.hash}: Sender account not found`);
    }

    const sender = getState(transaction.from!);
    const accountValidation = transaction.validateAgainstAccount(sender.balance, sender.nonce);
    if (!accountValidation.valid) {
      throw new Error(`Transaction ${transaction.hash}: ${accountValidation.error}`);
    }

    sender.balance -= transaction.amount + transaction.fee;
    sender.nonce++;
    getState(transaction.to).balance += transaction.amount;
  }

  const updates = [...accountStates].map(([address, state]): AccountChange => ({
    address,
    previous: previousStates.get(address) ?? null,
    state: state.balance === 0n && state.nonce === 0 ? null : { ...state },
  }));
  return { accountStates, updates, stateRoot: calculateStateRoot(parentStateRoot, updates) };
}
