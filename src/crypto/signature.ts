import * as secp256k1 from '@noble/secp256k1';
import { generateAddress } from './address';
import { hash, hexToBytes, bytesToHex } from './hash';
import { encodeCanonicalFields } from '../utils/serialization';

export interface TransactionData {
  chainId: number;
  kind: 'transfer' | 'coinbase';
  from: string | null;
  to: string;
  amount: bigint;
  nonce: number;
  fee: bigint;
  timestamp: number;
}

// configure secp256k1 with crypto functions using bun's native crypto
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  // use bun's crypto for hmac-sha256
  const key = Buffer.from(k);
  const hmac = new Bun.CryptoHasher('sha256', key);
  m.forEach(msg => hmac.update(msg));
  return new Uint8Array(hmac.digest());
};

// also need async version
secp256k1.etc.hmacSha256Async = async (k: Uint8Array, ...m: Uint8Array[]) => {
  const key = Buffer.from(k);
  const hmac = new Bun.CryptoHasher('sha256', key);
  m.forEach(msg => hmac.update(msg));
  return new Uint8Array(hmac.digest());
};

/**
 * sign a message with a private key
 */
export async function sign(
  message: string | Uint8Array,
  privateKey: Uint8Array | string
): Promise<string> {
  const msgBytes = typeof message === 'string'
    ? new TextEncoder().encode(message)
    : message;
  
  const privKeyBytes = typeof privateKey === 'string'
    ? hexToBytes(privateKey)
    : privateKey;
  
  // hash the message using bun's native crypto
  const msgHash = hexToBytes(hash(msgBytes, 'sha256'));
  
  // sign the hash
  const signature = await secp256k1.sign(msgHash, privKeyBytes);
  
  return signature.toCompactHex();
}

/**
 * verify a signature
 */
export async function verify(
  message: string | Uint8Array,
  signature: string | Uint8Array,
  publicKey: string | Uint8Array
): Promise<boolean> {
  try {
    const msgBytes = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : message;
    
    const sigBytes = typeof signature === 'string'
      ? hexToBytes(signature)
      : signature;
    
    const pubKeyBytes = typeof publicKey === 'string'
      ? hexToBytes(publicKey)
      : publicKey;
    
    // hash the message using bun's native crypto
    const msgHash = hexToBytes(hash(msgBytes, 'sha256'));
    
    // verify the signature
    return await secp256k1.verify(sigBytes, msgHash, pubKeyBytes);
  } catch {
    return false;
  }
}

/**
 * sign transaction data
 */
export async function signTransaction(
  txData: TransactionData,
  privateKey: Uint8Array | string
): Promise<{
  signature: string;
  publicKey: string;
}> {
  const privKeyBytes = typeof privateKey === 'string'
    ? hexToBytes(privateKey)
    : privateKey;
  
  // serialize transaction data deterministically
  const serialized = serializeTransactionData(txData);
  
  // sign the serialized data
  const signature = await sign(serialized, privKeyBytes);
  
  // get public key
  const publicKey = secp256k1.getPublicKey(privKeyBytes);
  
  return {
    signature,
    publicKey: bytesToHex(publicKey)
  };
}

/**
 * verify transaction signature
 */
export async function verifyTransaction(
  txData: TransactionData,
  signature: string | Uint8Array,
  publicKey: string | Uint8Array
): Promise<boolean> {
  // serialize transaction data the same way
  const serialized = serializeTransactionData(txData);
  
  // verify the signature
  return verify(serialized, signature, publicKey);
}

/**
 * serialize transaction data for signing
 */
export function serializeTransactionData(txData: TransactionData): Uint8Array {
  return encodeCanonicalFields([
    'bolt:transaction:v1',
    txData.chainId.toString(),
    txData.kind,
    txData.from ?? '',
    txData.to,
    txData.amount.toString(),
    txData.nonce.toString(),
    txData.fee.toString(),
    txData.timestamp.toString()
  ]);
}

/**
 * calculate transaction hash
 */
export function calculateTransactionHash(
  txData: TransactionData,
  signature?: string,
  publicKey?: string
): string {
  const serialized = serializeTransactionData(txData);
  if (!signature) return hash(serialized, 'sha256');
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) {
    throw new Error('Invalid transaction signature');
  }

  if (!publicKey || !/^(02|03)[0-9a-f]{64}$/.test(publicKey)) {
    throw new Error('Invalid transaction public key');
  }

  const encodedSignature = encodeCanonicalFields([
    hexToBytes(signature.toLowerCase()),
    hexToBytes(publicKey)
  ]);
  const signed = new Uint8Array(serialized.length + encodedSignature.length);
  signed.set(serialized);
  signed.set(encodedSignature, serialized.length);
  return hash(signed, 'sha256');
}

/**
 * generate new private key
 */
export function generatePrivateKey(): Uint8Array {
  let privKey: Uint8Array;
  
  // ensure we get a valid private key
  do {
    // use bun's crypto.getRandomValues for random bytes
    privKey = new Uint8Array(32);
    crypto.getRandomValues(privKey);
  } while (!secp256k1.utils.isValidPrivateKey(privKey));
  
  return privKey;
}

/**
 * get public key from private key
 */
export function derivePublicKey(privateKey: Uint8Array | string): Uint8Array {
  const privKeyBytes = typeof privateKey === 'string'
    ? hexToBytes(privateKey)
    : privateKey;
  
  return secp256k1.getPublicKey(privKeyBytes);
}

/**
 * validate private key
 */
export function isValidPrivateKey(privateKey: Uint8Array | string): boolean {
  try {
    const privKeyBytes = typeof privateKey === 'string'
      ? hexToBytes(privateKey)
      : privateKey;
    
    return secp256k1.utils.isValidPrivateKey(privKeyBytes);
  } catch {
    return false;
  }
}

/**
 * validate public key
 */
export function isValidPublicKey(publicKey: Uint8Array | string): boolean {
  try {
    const pubKeyBytes = typeof publicKey === 'string'
      ? hexToBytes(publicKey)
      : publicKey;
    
    return pubKeyBytes.length === 33 && secp256k1.Point.fromHex(pubKeyBytes).toRawBytes(true).every(
      (byte, index) => byte === pubKeyBytes[index]
    );
  } catch {
    return false;
  }
}
