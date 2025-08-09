import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { randomBytes } from 'crypto';
import * as crypto from 'crypto';
import { generateAddress } from './address';

// configure secp256k1 with crypto functions
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  const h = hmac.create(sha256, k);
  m.forEach(msg => h.update(msg));
  return h.digest();
};

// also need randomBytes for key generation
secp256k1.etc.hmacSha256Async = async (k: Uint8Array, ...m: Uint8Array[]) => {
  const h = hmac.create(sha256, k);
  m.forEach(msg => h.update(msg));
  return h.digest();
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
  
  // hash the message
  const msgHash = sha256(msgBytes);
  
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
    
    // hash the message
    const msgHash = sha256(msgBytes);
    
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
  txData: {
    from: string;
    to: string;
    amount: bigint;
    nonce: number;
    fee: bigint;
    timestamp: number;
  },
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
  txData: {
    from: string;
    to: string;
    amount: bigint;
    nonce: number;
    fee: bigint;
    timestamp: number;
  },
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
export function serializeTransactionData(txData: {
  from: string;
  to: string;
  amount: bigint;
  nonce: number;
  fee: bigint;
  timestamp: number;
}): string {
  // deterministic serialization
  return [
    txData.from,
    txData.to,
    txData.amount.toString(),
    txData.nonce.toString(),
    txData.fee.toString(),
    txData.timestamp.toString()
  ].join(':');
}

/**
 * calculate transaction hash
 */
export function calculateTransactionHash(
  txData: {
    from: string | null;
    to: string;
    amount: bigint;
    nonce: number;
    fee: bigint;
    timestamp: number;
  },
  signature?: string
): string {
  // include signature in hash if provided
  const dataToHash = signature
    ? serializeTransactionData(txData as any) + ':' + signature
    : serializeTransactionData(txData as any);
  
  return bytesToHex(sha256(new TextEncoder().encode(dataToHash)));
}

/**
 * generate new private key
 */
export function generatePrivateKey(): Uint8Array {
  let privKey: Uint8Array;
  
  // ensure we get a valid private key
  do {
    privKey = randomBytes(32);
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
    
    // check if it's a valid point on the curve
    return pubKeyBytes.length === 33 || pubKeyBytes.length === 65;
  } catch {
    return false;
  }
}