import { validateAddress } from '../crypto/address';
import { BlockClass } from '../core/block';
import type { Blockchain } from '../core/blockchain';
import type { Mempool } from '../core/mempool';
import { createCoinbaseTransaction } from '../core/transaction';
import type { Transaction } from '../types';

export interface BlockCandidate {
  block: BlockClass;
  transactions: Transaction[];
  blockReward: bigint;
  totalFees: bigint;
  blockSizeBytes: number;
}

export async function buildBlockCandidate(
  blockchain: Blockchain,
  mempool: Mempool,
  payoutAddress: string
): Promise<BlockCandidate> {
  const config = blockchain.getChainConfig();
  if (!validateAddress(payoutAddress, config.addressPrefix)) throw new Error('Invalid payout address');

  const previous = await blockchain.getLatestBlock();
  if (!previous) throw new Error('No previous block found');

  const height = previous.index + 1;
  const timestamp = Math.max(Date.now(), previous.timestamp + 1);
  const difficulty = await blockchain.getDifficulty(height);
  const blockReward = blockchain.calculateBlockReward(height);
  const transactions = mempool.getTransactionsForBlock(config.maxBlockSize);

  while (true) {
    const totalFees = transactions.reduce((sum, transaction) => sum + transaction.fee, 0n);
    const coinbase = createCoinbaseTransaction(
      config.chainId,
      payoutAddress,
      blockReward,
      totalFees,
      timestamp
    );
    const block = new BlockClass(
      height,
      timestamp,
      previous.hash,
      [coinbase.toObject(), ...transactions],
      difficulty,
      payoutAddress
    );
    await blockchain.prepareBlock(block);
    const currentTip = await blockchain.getLatestBlock();
    if (!currentTip || currentTip.index !== previous.index || currentTip.hash !== previous.hash) {
      return buildBlockCandidate(blockchain, mempool, payoutAddress);
    }

    block.nonce = Number.MAX_SAFE_INTEGER;
    block.hash = 'f'.repeat(64);
    const blockSizeBytes = block.getSize();
    block.nonce = 0;
    block.hash = '';

    if (blockSizeBytes <= config.maxBlockSize) {
      return { block, transactions: [...transactions], blockReward, totalFees, blockSizeBytes };
    }
    if (transactions.length === 0) throw new Error('Block envelope exceeds maximum block size');
    transactions.pop();
  }
}
