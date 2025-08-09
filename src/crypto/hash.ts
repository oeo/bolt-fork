import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { scrypt } from '@noble/hashes/scrypt';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export type HashAlgorithm = 'sha256' | 'sha512' | 'scrypt' | 'double-sha256';

interface ScryptOptions {
  N?: number;  // CPU/memory cost parameter (must be power of 2)
  r?: number;  // block size parameter
  p?: number;  // parallelization parameter
  dkLen?: number;  // desired key length
}

/**
 * Universal hash function supporting multiple algorithms
 */
export function hash(
  data: string | Uint8Array, 
  algorithm: HashAlgorithm = 'sha256',
  options?: ScryptOptions
): string {
  const bytes = typeof data === 'string' 
    ? new TextEncoder().encode(data)
    : data;
  
  switch (algorithm) {
    case 'sha256':
      return bytesToHex(sha256(bytes));
      
    case 'sha512':
      return bytesToHex(sha512(bytes));
      
    case 'double-sha256':
      const firstHash = sha256(bytes);
      return bytesToHex(sha256(firstHash));
      
    case 'scrypt': {
      // scrypt needs salt, we'll use first 32 bytes of data as salt
      // for consistent hashing (not for passwords!)
      const salt = bytes.slice(0, 32).length >= 32 
        ? bytes.slice(0, 32)
        : sha256(bytes).slice(0, 32);
      
      const params = {
        N: options?.N || 1024,  // lighter for blockchain use
        r: options?.r || 8,
        p: options?.p || 1,
        dkLen: options?.dkLen || 32
      };
      
      return bytesToHex(scrypt(bytes, salt, params));
    }
      
    default:
      throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }
}

/**
 * Calculate merkle root from transaction hashes
 */
export function calculateMerkleRoot(hashes: string[], algorithm: HashAlgorithm = 'sha256'): string {
  if (hashes.length === 0) return hash('', algorithm);
  if (hashes.length === 1) return hashes[0];
  
  let level = [...hashes];
  
  while (level.length > 1) {
    const nextLevel: string[] = [];
    
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left;
      const combined = left + right;
      nextLevel.push(hash(combined, algorithm));
    }
    
    level = nextLevel;
  }
  
  return level[0];
}

/**
 * Calculate target from difficulty
 * This works regardless of hash algorithm as we're comparing bigints
 */
export function difficultyToTarget(difficulty: number): bigint {
  // max value for 256-bit hash (works for all our algorithms)
  const maxTarget = BigInt('0x' + 'FF'.repeat(32));
  return maxTarget / BigInt(Math.max(1, Math.floor(difficulty)));
}

/**
 * Check if hash meets difficulty target
 * Algorithm-agnostic as it just compares the numerical value
 */
export function hashMeetsDifficulty(hashValue: string, difficulty: number): boolean {
  // for longer hashes (sha512), only use first 64 chars (256 bits)
  // this ensures consistent difficulty across algorithms
  const normalizedHash = hashValue.substring(0, 64).padStart(64, '0');
  const hashBigInt = BigInt('0x' + normalizedHash);
  const target = difficultyToTarget(difficulty);
  return hashBigInt <= target;
}

/**
 * Calculate chain version hash from config parameters
 */
export function calculateChainVersionHash(
  params: {
    version: string;
    network: string;
    hashAlgorithm: HashAlgorithm;
    initialDifficulty: number;
    difficultyAdjustmentInterval: number;
    targetBlockTime: number;
    maxSupply: bigint;
    initialBlockReward: bigint;
    halvingInterval: number;
  },
  algorithm?: HashAlgorithm
): string {
  const configString = JSON.stringify({
    version: params.version,
    network: params.network,
    hashAlgorithm: params.hashAlgorithm,
    initialDifficulty: params.initialDifficulty,
    difficultyAdjustmentInterval: params.difficultyAdjustmentInterval,
    targetBlockTime: params.targetBlockTime,
    maxSupply: params.maxSupply.toString(),
    initialBlockReward: params.initialBlockReward.toString(),
    halvingInterval: params.halvingInterval
  });
  
  // use specified algorithm or the chain's configured algorithm
  return hash(configString, algorithm || params.hashAlgorithm);
}

/**
 * Get hash output size in bytes for each algorithm
 */
export function getHashSize(algorithm: HashAlgorithm): number {
  switch (algorithm) {
    case 'sha256':
    case 'double-sha256':
    case 'scrypt':
      return 32; // 256 bits
    case 'sha512':
      return 64; // 512 bits
    default:
      return 32;
  }
}