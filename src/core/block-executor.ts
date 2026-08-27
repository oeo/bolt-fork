import type { AccountState, Block } from '../types';
import type { ChainConfig } from '../config/chain';
import { hash } from '../crypto/hash';
import { encodeCanonicalFields } from '../utils/serialization';
import { TransactionClass, validateTransactionPool } from './transaction';

export interface BlockExecution {
  accountStates: Map<string, AccountState>;
  stateRoot: string;
}

export function calculateStateRoot(accountStates: ReadonlyMap<string, AccountState>): string {
  const fields: string[] = ['bolt:state:v1'];
  for (const [address, state] of [...accountStates].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    fields.push(address, state.balance.toString(), state.nonce.toString());
  }
  return hash(encodeCanonicalFields(fields), 'sha256');
}

export async function executeBlock(
  block: Block,
  currentStates: ReadonlyMap<string, AccountState>,
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

  const initialAddresses = new Set(currentStates.keys());
  const accountStates = new Map(
    [...currentStates].map(([address, state]) => [address, { ...state }])
  );
  const getState = (address: string): AccountState => {
    const state = accountStates.get(address) ?? { balance: 0n, nonce: 0 };
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
    if (!initialAddresses.has(transaction.from!)) {
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

  return { accountStates, stateRoot: calculateStateRoot(accountStates) };
}
