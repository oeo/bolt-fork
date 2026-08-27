import { describe, expect, it } from 'bun:test';
import { BlockClass } from '../../src/core/block';
import { calculateStateRoot, executeBlock } from '../../src/core/block-executor';
import { createCoinbaseTransaction, createSignedTransaction } from '../../src/core/transaction';
import { devnet } from '../../src/config/chains/devnet';
import { generateAddress } from '../../src/crypto/address';

describe('block executor', () => {
  it('should derive complete state without mutating current state', async () => {
    const sender = generateAddress(devnet.addressPrefix);
    const recipient = generateAddress(devnet.addressPrefix);
    const miner = generateAddress(devnet.addressPrefix);
    const untouched = generateAddress(devnet.addressPrefix);
    const fee = 1000n;
    const reward = 5000000000n;
    const transfer = await createSignedTransaction(
      devnet.chainId,
      sender.address,
      recipient.address,
      1000000n,
      0,
      fee,
      sender.privateKey,
      1234567890
    );
    const coinbase = createCoinbaseTransaction(
      devnet.chainId,
      miner.address,
      reward,
      fee,
      1234567890
    );
    const block = new BlockClass(1, 1234567890, '0'.repeat(64), [coinbase, transfer], 1);
    const current = new Map([
      [sender.address, { balance: 2000000n, nonce: 0 }],
      [untouched.address, { balance: 7n, nonce: 4 }]
    ]);

    const execution = await executeBlock(block.toObject(), current, devnet, reward);

    expect(current.get(sender.address)).toEqual({ balance: 2000000n, nonce: 0 });
    expect(execution.accountStates.get(sender.address)).toEqual({ balance: 999000n, nonce: 1 });
    expect(execution.accountStates.get(recipient.address)).toEqual({ balance: 1000000n, nonce: 0 });
    expect(execution.accountStates.get(miner.address)).toEqual({ balance: reward + fee, nonce: 0 });
    expect(execution.accountStates.get(untouched.address)).toEqual({ balance: 7n, nonce: 4 });
    expect(execution.stateRoot).toBe(calculateStateRoot(execution.accountStates));
  });

  it('should calculate state roots independent of map insertion order', () => {
    const first = new Map([
      ['b', { balance: 2n, nonce: 1 }],
      ['a', { balance: 1n, nonce: 0 }]
    ]);
    const second = new Map([...first].reverse());

    expect(calculateStateRoot(first)).toBe(calculateStateRoot(second));
    expect(calculateStateRoot(first)).toBe('de23397172b152b5f7a2d974926f8f1722bd4efdb9676bf9d24ce25b513d0360');
  });

  it('should bind coinbase identity to block timestamp', async () => {
    const miner = generateAddress(devnet.addressPrefix);
    const coinbase = createCoinbaseTransaction(
      devnet.chainId,
      miner.address,
      5000000000n,
      0n,
      1234567890
    );
    const block = new BlockClass(1, 1234567891, '0'.repeat(64), [coinbase], 1);

    await expect(executeBlock(block.toObject(), new Map(), devnet, 5000000000n))
      .rejects.toThrow('Invalid coinbase transaction');
  });

  it('should reject transfers after the block timestamp', async () => {
    const sender = generateAddress(devnet.addressPrefix);
    const recipient = generateAddress(devnet.addressPrefix);
    const transfer = await createSignedTransaction(
      devnet.chainId,
      sender.address,
      recipient.address,
      1n,
      0,
      1n,
      sender.privateKey,
      2001
    );
    const coinbase = createCoinbaseTransaction(devnet.chainId, recipient.address, 1n, 1n, 2000);
    const block = new BlockClass(1, 2000, '0'.repeat(64), [coinbase, transfer], 1);

    await expect(executeBlock(
      block.toObject(),
      new Map([[sender.address, { balance: 2n, nonce: 0 }]]),
      devnet,
      1n
    )).rejects.toThrow('future');
  });
});
