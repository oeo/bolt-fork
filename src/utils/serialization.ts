/**
 * bun-optimized serialization utilities
 * uses native uint8array and dataview for performance
 */

/**
 * serialize a bigint to a buffer (8 bytes, big-endian)
 */
export function serializeBigInt(value: bigint): string {
  // for json storage, just use string representation
  return value.toString();
}

/**
 * deserialize a string back to bigint
 */
export function deserializeBigInt(value: string): bigint {
  return BigInt(value);
}

/**
 * serialize bigint to binary (8 bytes)
 */
export function bigIntToBuffer(value: bigint): Uint8Array {
  const buffer = new Uint8Array(8);
  const view = new DataView(buffer.buffer);
  view.setBigUint64(0, value, false); // big-endian
  return buffer;
}

/**
 * deserialize binary to bigint
 */
export function bufferToBigInt(buffer: Uint8Array, offset: number = 0): bigint {
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset);
  return view.getBigUint64(0, false); // big-endian
}

/**
 * efficient hex string to bytes conversion
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * efficient bytes to hex string conversion
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * serialize transaction to binary format
 */
export function serializeTransaction(tx: any): Uint8Array {
  // use bun's native string encoding
  const json = JSON.stringify({
    ...tx,
    amount: tx.amount.toString(),
    fee: tx.fee.toString(),
  });
  
  // bun provides optimized string to bytes conversion
  const encoder = new TextEncoder();
  return encoder.encode(json);
}

/**
 * deserialize transaction from binary format
 */
export function deserializeTransaction(data: Uint8Array): any {
  const decoder = new TextDecoder();
  const json = decoder.decode(data);
  const parsed = JSON.parse(json);
  
  return {
    ...parsed,
    amount: BigInt(parsed.amount),
    fee: BigInt(parsed.fee),
  };
}

/**
 * create sortable buffer key for bigint values
 * useful for lmdb indexes
 */
export function createSortableKey(value: bigint, suffix?: string): Uint8Array {
  const keySize = suffix ? 8 + suffix.length / 2 : 8;
  const key = new Uint8Array(keySize);
  const view = new DataView(key.buffer);
  
  // write value as big-endian for correct sorting
  view.setBigUint64(0, value, false);
  
  // append suffix if provided
  if (suffix) {
    const suffixBytes = hexToBytes(suffix);
    key.set(suffixBytes, 8);
  }
  
  return key;
}

/**
 * bun-optimized block header serialization
 */
export function serializeBlockHeader(header: any): Uint8Array {
  // fixed size: 4 + 32 + 32 + 8 + 4 + 4 = 84 bytes
  const buffer = new Uint8Array(84);
  const view = new DataView(buffer.buffer);
  
  let offset = 0;
  
  // index (4 bytes)
  view.setUint32(offset, header.index, false);
  offset += 4;
  
  // previous hash (32 bytes)
  const prevHashBytes = hexToBytes(header.previousHash);
  buffer.set(prevHashBytes, offset);
  offset += 32;
  
  // merkle root (32 bytes)
  const merkleBytes = hexToBytes(header.merkleRoot || '0'.repeat(64));
  buffer.set(merkleBytes, offset);
  offset += 32;
  
  // timestamp (8 bytes)
  view.setBigUint64(offset, BigInt(header.timestamp), false);
  offset += 8;
  
  // difficulty (4 bytes)
  view.setUint32(offset, header.difficulty, false);
  offset += 4;
  
  // nonce (4 bytes)
  view.setUint32(offset, header.nonce, false);
  
  return buffer;
}

/**
 * bun-optimized block header deserialization
 */
export function deserializeBlockHeader(buffer: Uint8Array): any {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  
  let offset = 0;
  
  const header = {
    index: view.getUint32(offset, false),
    previousHash: '',
    merkleRoot: '',
    timestamp: 0,
    difficulty: 0,
    nonce: 0,
  };
  offset += 4;
  
  header.previousHash = bytesToHex(buffer.slice(offset, offset + 32));
  offset += 32;
  
  header.merkleRoot = bytesToHex(buffer.slice(offset, offset + 32));
  offset += 32;
  
  header.timestamp = Number(view.getBigUint64(offset, false));
  offset += 8;
  
  header.difficulty = view.getUint32(offset, false);
  offset += 4;
  
  header.nonce = view.getUint32(offset, false);
  
  return header;
}