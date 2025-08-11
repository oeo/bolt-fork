import { getLogger } from '../utils/logger';
import type { Block } from '../core/block';
import type { Transaction } from '../core/transaction';

const logger = getLogger(__filename);

// network magic bytes for bolt network
export const NETWORK_MAGIC = 0xb017b017; // "bolt bolt" in hex-ish

// protocol version
export const PROTOCOL_VERSION = 1;

// message types
export enum MessageType {
  VERSION = 0x01,
  VERACK = 0x02,
  PING = 0x03,
  PONG = 0x04,
  GETBLOCKS = 0x10,
  GETDATA = 0x11,
  GETADDR = 0x12,
  GETHEADERS = 0x13,
  BLOCK = 0x20,
  TX = 0x21,
  INV = 0x22,
  HEADERS = 0x23,
  ADDR = 0x24,
  REJECT = 0x30,
  MEMPOOL = 0x31,
}

// inventory types
export enum InvType {
  TX = 1,
  BLOCK = 2,
  FILTERED_BLOCK = 3,
}

// rejection codes
export enum RejectCode {
  MALFORMED = 0x01,
  INVALID = 0x10,
  OBSOLETE = 0x11,
  DUPLICATE = 0x12,
  NONSTANDARD = 0x40,
  DUST = 0x41,
  INSUFFICIENT_FEE = 0x42,
  CHECKPOINT = 0x43,
}

// message header structure
export interface MessageHeader {
  magic: number;
  type: MessageType;
  length: number;
  checksum: number;
}

// version message
export interface VersionMessage {
  version: number;
  services: bigint;
  timestamp: number;
  addrRecv: string;
  addrFrom: string;
  nonce: bigint;
  userAgent: string;
  startHeight: number;
}

// inventory item
export interface InvItem {
  type: InvType;
  hash: string;
}

// address info
export interface AddressInfo {
  timestamp: number;
  services: bigint;
  address: string;
  port: number;
}

/**
 * bolt network protocol implementation
 * handles message serialization, deserialization, and validation
 */
export class Protocol {
  constructor() {
    // hashers are created per-use since Bun doesn't support reset
  }

  /**
   * serialize a message with header
   */
  serializeMessage(type: MessageType, payload: Uint8Array): Uint8Array {
    const header = this.createHeader(type, payload);
    const headerBytes = this.serializeHeader(header);
    
    // combine header and payload
    const message = new Uint8Array(headerBytes.length + payload.length);
    message.set(headerBytes, 0);
    message.set(payload, headerBytes.length);
    
    return message;
  }

  /**
   * deserialize a message from bytes
   */
  deserializeMessage(data: Uint8Array): { header: MessageHeader; payload: Uint8Array } | null {
    if (data.length < 16) {
      logger.debug('message too short for header');
      return null;
    }
    
    const header = this.deserializeHeader(data.slice(0, 16));
    if (!header) {
      logger.debug('invalid message header');
      return null;
    }
    
    if (data.length < 16 + header.length) {
      logger.debug('incomplete message payload');
      return null;
    }
    
    const payload = data.slice(16, 16 + header.length);
    
    // validate checksum
    if (!this.validateChecksum(payload, header.checksum)) {
      logger.warn('message checksum validation failed');
      return null;
    }
    
    return { header, payload };
  }

  /**
   * create message header
   */
  private createHeader(type: MessageType, payload: Uint8Array): MessageHeader {
    return {
      magic: NETWORK_MAGIC,
      type,
      length: payload.length,
      checksum: this.calculateChecksum(payload),
    };
  }

  /**
   * serialize header to bytes
   */
  private serializeHeader(header: MessageHeader): Uint8Array {
    const buffer = new ArrayBuffer(16);
    const view = new DataView(buffer);
    
    view.setUint32(0, header.magic, false); // big-endian
    view.setUint32(4, header.type, false);
    view.setUint32(8, header.length, false);
    view.setUint32(12, header.checksum, false);
    
    return new Uint8Array(buffer);
  }

  /**
   * deserialize header from bytes
   */
  private deserializeHeader(data: Uint8Array): MessageHeader | null {
    if (data.length < 16) return null;
    
    const view = new DataView(data.buffer, data.byteOffset, 16);
    
    const magic = view.getUint32(0, false);
    if (magic !== NETWORK_MAGIC) {
      logger.debug(`invalid magic bytes: ${magic.toString(16)}`);
      return null;
    }
    
    return {
      magic,
      type: view.getUint32(4, false),
      length: view.getUint32(8, false),
      checksum: view.getUint32(12, false),
    };
  }

  /**
   * calculate checksum for payload
   */
  private calculateChecksum(payload: Uint8Array): number {
    // create new hasher for each checksum (Bun doesn't have reset)
    const hasher1 = new Bun.CryptoHasher('sha256');
    hasher1.update(payload);
    const hash1 = hasher1.digest();
    
    // use first 4 bytes of double sha256 as checksum
    const hasher2 = new Bun.CryptoHasher('sha256');
    hasher2.update(hash1);
    const hash2 = hasher2.digest();
    
    // convert first 4 bytes to uint32
    const view = new DataView(hash2.buffer, hash2.byteOffset, 4);
    return view.getUint32(0, false);
  }

  /**
   * validate checksum
   */
  private validateChecksum(payload: Uint8Array, checksum: number): boolean {
    return this.calculateChecksum(payload) === checksum;
  }

  // message serializers

  /**
   * serialize version message
   */
  serializeVersion(msg: VersionMessage): Uint8Array {
    const encoder = new TextEncoder();
    const userAgentBytes = encoder.encode(msg.userAgent);
    
    // correct buffer size: 4 + 8 + 8 + 32 + 32 + 8 + 1 + userAgent + 4
    const bufferSize = 97 + userAgentBytes.length;
    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);
    let offset = 0;
    
    view.setUint32(offset, msg.version, false); offset += 4;
    view.setBigUint64(offset, msg.services, false); offset += 8;
    view.setBigUint64(offset, BigInt(msg.timestamp), false); offset += 8;
    
    // addresses (simplified - just store as 32 bytes each)
    const addrRecvBytes = encoder.encode(msg.addrRecv.padEnd(32, '\0'));
    new Uint8Array(buffer, offset, 32).set(addrRecvBytes.slice(0, 32));
    offset += 32;
    
    const addrFromBytes = encoder.encode(msg.addrFrom.padEnd(32, '\0'));
    new Uint8Array(buffer, offset, 32).set(addrFromBytes.slice(0, 32));
    offset += 32;
    
    view.setBigUint64(offset, msg.nonce, false); offset += 8;
    
    // user agent length and string
    view.setUint8(offset, userAgentBytes.length); offset += 1;
    new Uint8Array(buffer, offset, userAgentBytes.length).set(userAgentBytes);
    offset += userAgentBytes.length;
    
    view.setUint32(offset, msg.startHeight, false); offset += 4;
    
    return new Uint8Array(buffer);
  }

  /**
   * deserialize version message
   */
  deserializeVersion(data: Uint8Array): VersionMessage | null {
    if (data.length < 80) return null;
    
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    const decoder = new TextDecoder();
    let offset = 0;
    
    const version = view.getUint32(offset, false); offset += 4;
    const services = view.getBigUint64(offset, false); offset += 8;
    const timestamp = Number(view.getBigUint64(offset, false)); offset += 8;
    
    // read addresses
    const addrRecvBytes = new Uint8Array(data.buffer, data.byteOffset + offset, 32);
    const addrRecv = decoder.decode(addrRecvBytes).replace(/\0+$/, '');
    offset += 32;
    
    const addrFromBytes = new Uint8Array(data.buffer, data.byteOffset + offset, 32);
    const addrFrom = decoder.decode(addrFromBytes).replace(/\0+$/, '');
    offset += 32;
    
    const nonce = view.getBigUint64(offset, false); offset += 8;
    
    // read user agent
    const userAgentLen = view.getUint8(offset); offset += 1;
    const userAgentBytes = new Uint8Array(data.buffer, data.byteOffset + offset, userAgentLen);
    const userAgent = decoder.decode(userAgentBytes);
    offset += userAgentLen;
    
    const startHeight = view.getUint32(offset, false);
    
    return {
      version,
      services,
      timestamp,
      addrRecv,
      addrFrom,
      nonce,
      userAgent,
      startHeight,
    };
  }

  /**
   * serialize inventory message
   */
  serializeInv(items: InvItem[]): Uint8Array {
    const buffer = new ArrayBuffer(4 + items.length * 36);
    const view = new DataView(buffer);
    const encoder = new TextEncoder();
    
    view.setUint32(0, items.length, false);
    
    let offset = 4;
    for (const item of items) {
      view.setUint32(offset, item.type, false);
      offset += 4;
      
      // store hash as 32 bytes
      const hashBytes = encoder.encode(item.hash.padEnd(32, '\0'));
      new Uint8Array(buffer, offset, 32).set(hashBytes.slice(0, 32));
      offset += 32;
    }
    
    return new Uint8Array(buffer);
  }

  /**
   * deserialize inventory message
   */
  deserializeInv(data: Uint8Array): InvItem[] | null {
    if (data.length < 4) return null;
    
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    const decoder = new TextDecoder();
    
    const count = view.getUint32(0, false);
    if (data.length < 4 + count * 36) return null;
    
    const items: InvItem[] = [];
    let offset = 4;
    
    for (let i = 0; i < count; i++) {
      const type = view.getUint32(offset, false) as InvType;
      offset += 4;
      
      const hashBytes = new Uint8Array(data.buffer, data.byteOffset + offset, 32);
      const hash = decoder.decode(hashBytes).replace(/\0+$/, '');
      offset += 32;
      
      items.push({ type, hash });
    }
    
    return items;
  }

  /**
   * serialize ping/pong message
   */
  serializePing(nonce: bigint): Uint8Array {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setBigUint64(0, nonce, false);
    return new Uint8Array(buffer);
  }

  /**
   * deserialize ping/pong message
   */
  deserializePing(data: Uint8Array): bigint | null {
    if (data.length < 8) return null;
    const view = new DataView(data.buffer, data.byteOffset, 8);
    return view.getBigUint64(0, false);
  }

  /**
   * serialize getblocks message
   */
  serializeGetBlocks(version: number, hashes: string[], stopHash: string): Uint8Array {
    const encoder = new TextEncoder();
    const buffer = new ArrayBuffer(8 + hashes.length * 32 + 32);
    const view = new DataView(buffer);
    
    view.setUint32(0, version, false);
    view.setUint32(4, hashes.length, false);
    
    let offset = 8;
    for (const hash of hashes) {
      const hashBytes = encoder.encode(hash.padEnd(32, '\0'));
      new Uint8Array(buffer, offset, 32).set(hashBytes.slice(0, 32));
      offset += 32;
    }
    
    const stopBytes = encoder.encode(stopHash.padEnd(32, '\0'));
    new Uint8Array(buffer, offset, 32).set(stopBytes.slice(0, 32));
    
    return new Uint8Array(buffer);
  }

  /**
   * serialize reject message
   */
  serializeReject(
    messageType: MessageType,
    code: RejectCode,
    reason: string,
    data?: Uint8Array
  ): Uint8Array {
    const encoder = new TextEncoder();
    const reasonBytes = encoder.encode(reason);
    
    const buffer = new ArrayBuffer(
      1 + 1 + 1 + reasonBytes.length + (data?.length || 0)
    );
    const view = new DataView(buffer);
    
    let offset = 0;
    view.setUint8(offset++, messageType);
    view.setUint8(offset++, code);
    view.setUint8(offset++, reasonBytes.length);
    
    new Uint8Array(buffer, offset, reasonBytes.length).set(reasonBytes);
    offset += reasonBytes.length;
    
    if (data) {
      new Uint8Array(buffer, offset, data.length).set(data);
    }
    
    return new Uint8Array(buffer);
  }
}