import * as bip39 from 'bip39';
import { BoltApiClient } from '../../src/api/client';
import { createHDKey, deriveKey, validateAddress } from '../../src/crypto/address';
import { createSignedTransaction } from '../../src/core/transaction';
import { createKeystore, openKeystore } from './keystore';
import { parseAmount } from './amount';

const DERIVATION_PATH = "m/44'/1057'/0'/0/0";
const [, , command, ...args] = process.argv;

if (!command) usage();

const option = (name: string, fallback?: string): string => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const api = new BoltApiClient(option('--api', process.env.BOLT_API || 'http://127.0.0.1:7333'));

if (command === 'create' || command === 'import') {
  const path = option('--keystore');
  const info = await verifiedInfo();
  const mnemonic = command === 'create' ? bip39.generateMnemonic(256) : await readSecret('Mnemonic: ');
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic');
  const password = await readSecret('Password: ');
  const confirmation = await readSecret('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');
  await createKeystore(path, mnemonic, password, {
    chainId: info.chainId,
    genesisHash: info.genesisHash,
    addressPrefix: info.addressPrefix,
    path: DERIVATION_PATH,
  });
  const wallet = derive(mnemonic, info.addressPrefix);
  console.log(`address: ${wallet.address}`);
  if (command === 'create') console.log(`mnemonic: ${mnemonic}`);
} else if (command === 'show' || command === 'send') {
  const { wallet, info } = await unlock(option('--keystore'));
  const state = await api.accountState(wallet.address);
  if (command === 'show') {
    console.log(JSON.stringify(state, bigintJson, 2));
  } else {
    const to = option('--to');
    if (!validateAddress(to, info.addressPrefix)) throw new Error('Invalid testnet recipient');
    const amount = parseAmount(option('--amount'));
    if (amount > state.availableBalance) throw new Error('Insufficient available balance');
    let fee = 0n;
    let transaction;
    for (let attempt = 0; attempt < 5; attempt++) {
      transaction = await createSignedTransaction(
        info.chainId, wallet.address, to, amount, state.nextNonce, fee, wallet.privateKey
      );
      const required = BigInt(transaction.getSize()) * info.minFeePerByte;
      if (required <= fee) break;
      fee = required;
    }
    if (!transaction || transaction.fee < BigInt(transaction.getSize()) * info.minFeePerByte) {
      throw new Error('Fee did not converge');
    }
    console.log(JSON.stringify({ from: wallet.address, to, amount, fee, nonce: state.nextNonce }, bigintJson, 2));
    if ((await readSecret('Type SEND to submit: ')) !== 'SEND') throw new Error('Cancelled');
    console.log(JSON.stringify(await api.submit(transaction.toObject()), null, 2));
  }
} else if (command === 'status') {
  console.log(JSON.stringify(await api.transaction(option('--hash')), bigintJson, 2));
} else {
  usage();
}

async function verifiedInfo() {
  const info = await api.chainInfo();
  if (info.network !== 'testnet' || info.chainId !== 1058 || info.addressPrefix !== 0x6f) {
    throw new Error('Endpoint is not bolt testnet');
  }
  return info;
}

async function unlock(path: string) {
  const password = await readSecret('Password: ');
  const opened = await openKeystore(path, password);
  const info = await verifiedInfo();
  if (opened.identity.chainId !== info.chainId || opened.identity.genesisHash !== info.genesisHash ||
      opened.identity.addressPrefix !== info.addressPrefix) throw new Error('Keystore belongs to another chain');
  return { wallet: derive(opened.mnemonic, info.addressPrefix), info };
}

function derive(mnemonic: string, prefix: number) {
  return deriveKey(createHDKey(mnemonic), {}, prefix);
}

async function readSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Secret input requires a TTY');
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  try {
    for await (const chunk of process.stdin) {
      const text = chunk.toString();
      if (text === '\r' || text === '\n') break;
      if (text === '\u0003') throw new Error('Cancelled');
      if (text === '\u007f') value = value.slice(0, -1);
      else value += text;
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
  }
  return value.trim();
}

function bigintJson(_key: string, value: unknown) {
  return typeof value === 'bigint' ? `${value}n` : value;
}

function usage(): never {
  throw new Error('Usage: create|import|show|send|status --api URL [--keystore PATH]');
}
