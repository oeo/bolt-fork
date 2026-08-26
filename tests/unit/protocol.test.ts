import { describe, it, expect, beforeEach } from 'bun:test';
import {
  Protocol,
  MessageType,
  InvType,
  RejectCode,
  PROTOCOL_VERSION,
  getNetworkMagic,
} from '../../src/network/protocol';
import { createCoinbaseTransaction } from '../../src/core/transaction';
import { SyncManager } from '../../src/network/sync-manager';
import { EventEmitter } from 'events';
import { mainnet } from '../../src/config/chains/mainnet';
import { generateAddress } from '../../src/crypto/address';

const genesisHash = 'a'.repeat(64);

describe('network protocol', () => {
  let protocol: Protocol;

  beforeEach(() => {
    protocol = new Protocol({
      chainId: mainnet.chainId,
      genesisHash,
      maxPayloadSize: 1024 * 1024
    });
  });

  describe('message serialization', () => {
    it('should use the chain-bound protocol version', () => {
      expect(PROTOCOL_VERSION).toBe(5);
    });

    it('should serialize and deserialize messages with correct header', () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      const message = protocol.serializeMessage(MessageType.PING, payload);

      // check message structure
      expect(message.length).toBe(56 + payload.length); // header + payload

      // deserialize
      const result = protocol.deserializeMessage(message);
      expect(result).not.toBeNull();
      expect(result!.header.magic).toBe(getNetworkMagic(mainnet.chainId));
      expect(result!.header.type).toBe(MessageType.PING);
      expect(result!.header.length).toBe(payload.length);
      expect(result!.payload).toEqual(payload);
    });

    it('should reject messages with invalid magic bytes', () => {
      const badMessage = new Uint8Array(60);
      // set wrong magic bytes
      new DataView(badMessage.buffer).setUint32(0, 0xdeadbeef, false);
      
      const result = protocol.deserializeMessage(badMessage);
      expect(result).toBeNull();
    });

    it('should reject frames from another chain', () => {
      const other = new Protocol({
        chainId: mainnet.chainId + 1,
        genesisHash,
        maxPayloadSize: 1024 * 1024
      });
      const message = other.serializeMessage(MessageType.PING, new Uint8Array(8));

      expect(protocol.deserializeMessage(message)).toBeNull();
    });

    it('should reject messages with invalid checksum', () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      const message = protocol.serializeMessage(MessageType.PING, payload);
      
      // corrupt checksum
      message[15] = 0xff;
      
      const result = protocol.deserializeMessage(message);
      expect(result).toBeNull();
    });

    it('should handle empty payload', () => {
      const payload = new Uint8Array(0);
      const message = protocol.serializeMessage(MessageType.VERACK, payload);

      const result = protocol.deserializeMessage(message);
      expect(result).not.toBeNull();
      expect(result!.payload.length).toBe(0);
    });

    it('should handle large payloads', () => {
      const payload = new Uint8Array(1024 * 1024); // 1mb
      payload.fill(42);
      
      const message = protocol.serializeMessage(MessageType.BLOCK, payload);
      const result = protocol.deserializeMessage(message);
      
      expect(result).not.toBeNull();
      expect(result!.payload.length).toBe(payload.length);
      expect(result!.payload).toEqual(payload);
    });

    it('should round-trip chain-bound transactions', () => {
      const transaction = createCoinbaseTransaction(
        1057,
        '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        5000000000n,
        0n,
        1234567890
      ).toObject();

      const decoded = protocol.decodeMessage(protocol.encodeMessage('tx', transaction));
      expect(decoded?.command).toBe('tx');
      expect(decoded?.payload).toEqual(transaction);
    });

    it('should reject malformed transaction payloads without throwing', () => {
      const message = protocol.serializeMessage(MessageType.TX, new TextEncoder().encode('{'));
      expect(() => protocol.decodeMessage(message)).not.toThrow();
      expect(protocol.decodeMessage(message)).toBeNull();
    });

    it('should reject malformed version payloads without throwing', () => {
      const message = protocol.serializeMessage(MessageType.VERSION, new TextEncoder().encode('{'));
      expect(() => protocol.decodeMessage(message)).not.toThrow();
      expect(protocol.decodeMessage(message)).toBeNull();
    });
  });

  describe('version message', () => {
    it('should disconnect peers using an obsolete protocol version', async () => {
      let disconnected = false;
      let sent = false;
      const connectionManager = Object.assign(new EventEmitter(), {
        disconnect: () => { disconnected = true; },
        updatePeerInfo: () => {},
        sendMessage: () => { sent = true; },
        getConnection: () => ({ inbound: false, expectedPeerId: 'peer' })
      });
      const discoveryService = Object.assign(new EventEmitter(), {
        getPeer: () => null
      });
      const identity = generateAddress(mainnet.addressPrefix);
      const syncManager = new SyncManager({
        blockchain: {} as any,
        connectionManager: connectionManager as any,
        protocol,
        discoveryService: discoveryService as any,
        chainConfig: mainnet,
        genesisHash,
        identity: { ...identity, createdAt: 0 }
      });
      (syncManager as any).handshakes.set('peer', {
        inbound: false,
        localNonce: 1n,
        versionReceived: false
      });
      const message = protocol.encodeMessage('version', {
        version: PROTOCOL_VERSION - 1,
        services: 1n,
        timestamp: 1234567890,
        nonce: 1n,
        userAgent: 'obsolete',
        startHeight: 0,
        chainId: mainnet.chainId,
        genesisHash,
        nodeId: identity.address,
        publicKey: identity.publicKey,
        signature: 'ab'.repeat(64)
      });

      connectionManager.emit('message:received', 'peer', message);
      await Bun.sleep(0);
      expect(disconnected).toBe(true);
      expect(sent).toBe(false);
    });

    it('should serialize and deserialize version message', () => {
      const versionMsg = {
        version: PROTOCOL_VERSION,
        services: 1n,
        timestamp: Math.floor(Date.now() / 1000),
        nonce: 123456789n,
        userAgent: 'bolt-test/1.0',
        startHeight: 100,
        chainId: mainnet.chainId,
        genesisHash,
        nodeId: generateAddress(mainnet.addressPrefix).address,
        publicKey: generateAddress(mainnet.addressPrefix).publicKey,
        signature: 'ab'.repeat(64)
      };

      const serialized = protocol.serializeVersion(versionMsg);
      const deserialized = protocol.deserializeVersion(serialized);

      expect(deserialized).not.toBeNull();
      expect(deserialized!.version).toBe(versionMsg.version);
      expect(deserialized!.services).toBe(versionMsg.services);
      expect(deserialized!.timestamp).toBe(versionMsg.timestamp);
      expect(deserialized!.nonce).toBe(versionMsg.nonce);
      expect(deserialized!.userAgent).toBe(versionMsg.userAgent);
      expect(deserialized!.startHeight).toBe(versionMsg.startHeight);
    });

    it('should handle long user agent strings', () => {
      const versionMsg = {
        version: PROTOCOL_VERSION,
        services: 0n,
        timestamp: 1234567890,
        nonce: 0n,
        userAgent: 'a'.repeat(255), // max length
        startHeight: 0,
        chainId: mainnet.chainId,
        genesisHash,
        nodeId: generateAddress(mainnet.addressPrefix).address,
        publicKey: generateAddress(mainnet.addressPrefix).publicKey,
        signature: 'ab'.repeat(64)
      };

      const serialized = protocol.serializeVersion(versionMsg);
      const deserialized = protocol.deserializeVersion(serialized);

      expect(deserialized).not.toBeNull();
      expect(deserialized!.userAgent).toBe(versionMsg.userAgent);
    });

    it('should serialize and deserialize signed verack messages', () => {
      const verack = {
        role: 'initiator' as const,
        senderNodeId: generateAddress(mainnet.addressPrefix).address,
        receiverNodeId: generateAddress(mainnet.addressPrefix).address,
        senderNonce: 1n,
        receiverNonce: 2n,
        signature: 'ab'.repeat(64)
      };

      expect(protocol.deserializeVerack(protocol.serializeVerack(verack))).toEqual(verack);
    });
  });

  describe('headers message', () => {
    it('should round-trip state roots', () => {
      const headers = [{
        height: 1,
        hash: '1'.repeat(64),
        previousHash: '2'.repeat(64),
        merkleRoot: '3'.repeat(64),
        stateRoot: '4'.repeat(64),
        timestamp: 1234567890,
        difficulty: 10,
        nonce: 7
      }];

      expect(protocol.deserializeHeaders(protocol.serializeHeaders(headers))).toEqual(headers);
    });
  });

  describe('inventory message', () => {
    it('should serialize and deserialize inventory message', () => {
      const items = [
        { type: InvType.TX, hash: '1234567890abcdef' + '0'.repeat(48) },
        { type: InvType.BLOCK, hash: 'fedcba0987654321' + '0'.repeat(48) },
        { type: InvType.FILTERED_BLOCK, hash: 'abcdef1234567890' + '0'.repeat(48) },
      ];

      const serialized = protocol.serializeInv(items);
      const deserialized = protocol.deserializeInv(serialized);

      expect(deserialized).not.toBeNull();
      expect(deserialized!.length).toBe(items.length);
      
      for (let i = 0; i < items.length; i++) {
        expect(deserialized![i].type).toBe(items[i].type);
        expect(deserialized![i].hash).toBe(items[i].hash);
      }
    });

    it('should handle empty inventory', () => {
      const items: any[] = [];
      
      const serialized = protocol.serializeInv(items);
      const deserialized = protocol.deserializeInv(serialized);

      expect(deserialized).not.toBeNull();
      expect(deserialized!.length).toBe(0);
    });

    it('should handle many inventory items', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        type: InvType.TX,
        hash: `tx${i}`,
      }));

      const serialized = protocol.serializeInv(items);
      const deserialized = protocol.deserializeInv(serialized);

      expect(deserialized).not.toBeNull();
      expect(deserialized!.length).toBe(100);
    });

    it('should reject oversized protocol collections', () => {
      const hash = '0'.repeat(64);
      const inventory = Array.from({ length: 501 }, () => ({ type: InvType.TX, hash }));

      expect(() => protocol.serializeInv(inventory)).toThrow('inventory item limit');
      expect(() => protocol.serializeGetBlocks(PROTOCOL_VERSION, Array(102).fill(hash), hash)).toThrow('locator limit');
      expect(() => protocol.serializeGetHeaders(Array(102).fill(hash), hash)).toThrow('locator limit');
      expect(() => protocol.serializeHeaders(Array(2001).fill({}))).toThrow('header limit');

      const inventoryDeclaration = new Uint8Array(4);
      new DataView(inventoryDeclaration.buffer).setUint32(0, 501, false);
      expect(protocol.deserializeInv(inventoryDeclaration)).toBeNull();
      expect(protocol.decodeMessage(protocol.serializeMessage(MessageType.GETDATA, inventoryDeclaration))).toBeNull();

      const getHeadersDeclaration = new Uint8Array(36);
      new DataView(getHeadersDeclaration.buffer).setUint32(0, 102, false);
      expect(protocol.deserializeGetHeaders(getHeadersDeclaration)).toBeNull();

      const getBlocksDeclaration = new Uint8Array(40);
      new DataView(getBlocksDeclaration.buffer).setUint32(4, 102, false);
      expect(protocol.deserializeGetBlocks(getBlocksDeclaration)).toBeNull();

      const headersDeclaration = new Uint8Array(4);
      new DataView(headersDeclaration.buffer).setUint32(0, 2001, false);
      expect(protocol.deserializeHeaders(headersDeclaration)).toBeNull();
    });
  });

  describe('ping/pong message', () => {
    it('should serialize and deserialize ping message', () => {
      const nonce = 9876543210123456n;
      
      const serialized = protocol.serializePing(nonce);
      const deserialized = protocol.deserializePing(serialized);

      expect(deserialized).not.toBeNull();
      expect(deserialized).toBe(nonce);
    });

    it('should handle max nonce value', () => {
      const nonce = BigInt('0xFFFFFFFFFFFFFFFF');
      
      const serialized = protocol.serializePing(nonce);
      const deserialized = protocol.deserializePing(serialized);

      expect(deserialized).toBe(nonce);
    });

    it('should handle zero nonce', () => {
      const nonce = 0n;
      
      const serialized = protocol.serializePing(nonce);
      const deserialized = protocol.deserializePing(serialized);

      expect(deserialized).toBe(nonce);
    });
  });

  describe('getblocks message', () => {
    it('should serialize getblocks message', () => {
      const version = PROTOCOL_VERSION;
      const hashes = ['hash1', 'hash2', 'hash3'];
      const stopHash = 'stophash';

      const serialized = protocol.serializeGetBlocks(version, hashes, stopHash);

      // check structure
      const view = new DataView(serialized.buffer);
      expect(view.getUint32(0, false)).toBe(version);
      expect(view.getUint32(4, false)).toBe(hashes.length);
      
      // should be 8 + (3 * 32) + 32 = 136 bytes
      expect(serialized.length).toBe(136);
    });

    it('should handle empty hash list', () => {
      const serialized = protocol.serializeGetBlocks(1, [], 'stop');
      
      const view = new DataView(serialized.buffer);
      expect(view.getUint32(4, false)).toBe(0);
      expect(serialized.length).toBe(40); // 8 + 32
    });
  });

  describe('reject message', () => {
    it('should serialize reject message', () => {
      const serialized = protocol.serializeReject(
        MessageType.TX,
        RejectCode.INVALID,
        'invalid transaction',
        new Uint8Array([1, 2, 3])
      );

      // check basic structure
      const view = new DataView(serialized.buffer);
      expect(view.getUint8(0)).toBe(MessageType.TX);
      expect(view.getUint8(1)).toBe(RejectCode.INVALID);
      
      // reason length
      const reasonLen = view.getUint8(2);
      expect(reasonLen).toBe('invalid transaction'.length);
    });

    it('should handle reject without data', () => {
      const serialized = protocol.serializeReject(
        MessageType.BLOCK,
        RejectCode.DUPLICATE,
        'duplicate block'
      );

      expect(serialized.length).toBe(3 + 'duplicate block'.length);
    });

    it('should handle empty reason', () => {
      const serialized = protocol.serializeReject(
        MessageType.VERSION,
        RejectCode.OBSOLETE,
        ''
      );

      const view = new DataView(serialized.buffer);
      expect(view.getUint8(2)).toBe(0); // empty reason
      expect(serialized.length).toBe(3);
    });
  });

  describe('checksum calculation', () => {
    it('should calculate consistent checksums', () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      
      // serialize twice
      const msg1 = protocol.serializeMessage(MessageType.PING, payload);
      const msg2 = protocol.serializeMessage(MessageType.PING, payload);
      
      // extract checksums
      const view1 = new DataView(msg1.buffer, 0, 56);
      const view2 = new DataView(msg2.buffer, 0, 56);
      
      const checksum1 = view1.getUint32(12, false);
      const checksum2 = view2.getUint32(12, false);
      
      expect(checksum1).toBe(checksum2);
    });

    it('should produce different checksums for different payloads', () => {
      const payload1 = new Uint8Array([1, 2, 3]);
      const payload2 = new Uint8Array([4, 5, 6]);
      
      const msg1 = protocol.serializeMessage(MessageType.PING, payload1);
      const msg2 = protocol.serializeMessage(MessageType.PING, payload2);
      
      const view1 = new DataView(msg1.buffer, 0, 56);
      const view2 = new DataView(msg2.buffer, 0, 56);
      
      const checksum1 = view1.getUint32(12, false);
      const checksum2 = view2.getUint32(12, false);
      
      expect(checksum1).not.toBe(checksum2);
    });
  });

  describe('message boundaries', () => {
    it('should handle partial messages', () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      const message = protocol.serializeMessage(MessageType.PING, payload);
      
      // try with partial message
      const partial = message.slice(0, 10);
      const result = protocol.deserializeMessage(partial);
      
      expect(result).toBeNull();
    });

    it('should handle multiple messages in buffer', () => {
      const payload1 = new Uint8Array([1, 2, 3]);
      const payload2 = new Uint8Array([4, 5, 6]);
      
      const msg1 = protocol.serializeMessage(MessageType.PING, payload1);
      const msg2 = protocol.serializeMessage(MessageType.PONG, payload2);
      
      // combine messages
      const combined = new Uint8Array(msg1.length + msg2.length);
      combined.set(msg1, 0);
      combined.set(msg2, msg1.length);
      
      // deserialize first message
      const result1 = protocol.deserializeMessage(combined);
      expect(result1).not.toBeNull();
      expect(result1!.header.type).toBe(MessageType.PING);
      expect(result1!.payload).toEqual(payload1);
      
      // deserialize second message
      const remaining = combined.slice(msg1.length);
      const result2 = protocol.deserializeMessage(remaining);
      expect(result2).not.toBeNull();
      expect(result2!.header.type).toBe(MessageType.PONG);
      expect(result2!.payload).toEqual(payload2);
    });
  });
});
