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

    const parentRoot = '1'.repeat(64);
    const execution = await executeBlock(block.toObject(), current, parentRoot, devnet, reward);

    expect(current.get(sender.address)).toEqual({ balance: 2000000n, nonce: 0 });
    expect(execution.accountStates.get(sender.address)).toEqual({ balance: 999000n, nonce: 1 });
    expect(execution.accountStates.get(recipient.address)).toEqual({ balance: 1000000n, nonce: 0 });
    expect(execution.accountStates.get(miner.address)).toEqual({ balance: reward + fee, nonce: 0 });
    expect(execution.accountStates.has(untouched.address)).toBe(false);
    expect(execution.stateRoot).toBe(calculateStateRoot(parentRoot, execution.updates));
  });

  it('should calculate state roots independent of map insertion order', () => {
    const first = [
      { address: 'b', previous: null, state: { balance: 2n, nonce: 1 } },
      { address: 'a', previous: null, state: { balance: 1n, nonce: 0 } },
    ];
    const second = [...first].reverse();

    expect(calculateStateRoot('0'.repeat(64), first)).toBe(calculateStateRoot('0'.repeat(64), second));
    expect(calculateStateRoot('0'.repeat(64), first)).toBe('fd1b6827d0b28de4cc78113fcc69bf62012bc049860ac821860799c1bd1190ae');
    expect(calculateStateRoot('1'.repeat(64), [{
      address: 'a', previous: { balance: 1n, nonce: 0 }, state: null,
    }])).toBe('c5f44835c5ee384217868144f99f49d75e985cf787271d996cb0c0dc68813937');
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

    await expect(executeBlock(block.toObject(), new Map(), '0'.repeat(64), devnet, 5000000000n))
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
      '0'.repeat(64),
      devnet,
      1n
    )).rejects.toThrow('future');
  });

  it('should process sequential changes from one account', async () => {
    const sender = generateAddress(devnet.addressPrefix);
    const recipient = generateAddress(devnet.addressPrefix);
    const miner = generateAddress(devnet.addressPrefix);
    const first = await createSignedTransaction(
      devnet.chainId, sender.address, recipient.address, 3n, 0, 1n, sender.privateKey, 1000
    );
    const second = await createSignedTransaction(
      devnet.chainId, sender.address, recipient.address, 2n, 1, 1n, sender.privateKey, 1001
    );
    const coinbase = createCoinbaseTransaction(devnet.chainId, miner.address, 5n, 2n, 1001);
    const block = new BlockClass(1, 1001, '0'.repeat(64), [coinbase, first, second], 1);

    const execution = await executeBlock(
      block.toObject(),
      new Map([[sender.address, { balance: 10n, nonce: 0 }]]),
      '0'.repeat(64),
      devnet,
      5n
    );

    expect(execution.accountStates.get(sender.address)).toEqual({ balance: 3n, nonce: 2 });
    expect(execution.accountStates.get(recipient.address)).toEqual({ balance: 5n, nonce: 0 });
    expect(execution.updates.find(update => update.address === sender.address)?.previous)
      .toEqual({ balance: 10n, nonce: 0 });
  });

  it('should preserve zero transfers while deleting empty resulting accounts', async () => {
    const sender = generateAddress(devnet.addressPrefix);
    const recipient = generateAddress(devnet.addressPrefix);
    const miner = generateAddress(devnet.addressPrefix);
    const transfer = await createSignedTransaction(
      devnet.chainId, sender.address, recipient.address, 0n, 0, 1n, sender.privateKey, 1000
    );
    const coinbase = createCoinbaseTransaction(devnet.chainId, miner.address, 0n, 1n, 1000);
    const block = new BlockClass(1, 1000, '0'.repeat(64), [coinbase, transfer], 1);

    const execution = await executeBlock(
      block.toObject(),
      new Map([[sender.address, { balance: 1n, nonce: 0 }]]),
      '0'.repeat(64),
      devnet,
      0n
    );

    expect(execution.updates.find(update => update.address === recipient.address)).toEqual({
      address: recipient.address,
      previous: null,
      state: null,
    });
    expect(execution.accountStates.get(sender.address)).toEqual({ balance: 0n, nonce: 1 });
  });
});
