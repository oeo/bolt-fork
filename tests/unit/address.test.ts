import { describe, it, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import {
  publicKeyToAddress,
  validateAddress,
  generateAddress,
  createHDKey,
  deriveKey
} from '../../src/crypto/address';

// Network prefix constants
const NetworkPrefix = {
  MAINNET: 0x00,
  TESTNET: 0x6F,
  LOCAL: 0xEF
};
import { getPublicKey } from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

describe('Address Functions', () => {
  
  // base58 encode/decode tests removed - functions not exported
  
  describe('publicKeyToAddress', () => {
    it('should generate valid mainnet address', () => {
      const privateKey = randomBytes(32);
      const publicKey = getPublicKey(privateKey);
      const address = publicKeyToAddress(publicKey, NetworkPrefix.MAINNET);
      
      expect(address).toBeTruthy();
      expect(address[0]).toBe('1'); // mainnet addresses start with '1'
      expect(validateAddress(address)).toBe(true);
    });
    
    it('should generate valid testnet address', () => {
      const privateKey = randomBytes(32);
      const publicKey = getPublicKey(privateKey);
      const address = publicKeyToAddress(publicKey, NetworkPrefix.TESTNET);
      
      expect(address).toBeTruthy();
      expect(['m', 'n'].includes(address[0])).toBe(true); // testnet addresses
      expect(validateAddress(address)).toBe(true);
    });
    
    it('should accept hex string public key', () => {
      const privateKey = randomBytes(32);
      const publicKey = getPublicKey(privateKey);
      const publicKeyHex = bytesToHex(publicKey);
      
      const address1 = publicKeyToAddress(publicKey);
      const address2 = publicKeyToAddress(publicKeyHex);
      
      expect(address1).toBe(address2);
    });
  });
  
  describe('validateAddress', () => {
    it('should enforce the expected network prefix', () => {
      const { address } = generateAddress(NetworkPrefix.LOCAL);
      expect(validateAddress(address, NetworkPrefix.LOCAL)).toBe(true);
      expect(validateAddress(address, NetworkPrefix.MAINNET)).toBe(false);
    });

    it('should validate correct address', () => {
      const { address } = generateAddress();
      expect(validateAddress(address)).toBe(true);
    });
    
    it('should reject address with wrong checksum', () => {
      const { address } = generateAddress();
      
      // corrupt the address by changing multiple characters to ensure checksum fails
      // change the last 4 characters which are part of the checksum
      const corrupted = address.slice(0, -4) + '1111';
      expect(validateAddress(corrupted)).toBe(false);
    });
    
    it('should reject address with wrong length', () => {
      expect(validateAddress('1234')).toBe(false);
      expect(validateAddress('1' + 'A'.repeat(50))).toBe(false);
    });
    
    it('should reject non-base58 addresses', () => {
      expect(validateAddress('0000')).toBe(false);
      expect(validateAddress('IIII')).toBe(false);
    });
  });
  
  // addressToPubKeyHash and getAddressPrefix tests removed - functions not exported
  
  describe('generateAddress', () => {
    it('should generate complete keypair and address', () => {
      const result = generateAddress();
      
      expect(result.privateKey).toBeTruthy();
      expect(result.privateKey.length).toBe(64); // 32 bytes hex
      expect(result.publicKey).toBeTruthy();
      expect(result.publicKey.length).toBe(130); // 65 bytes uncompressed hex
      expect(result.address).toBeTruthy();
      expect(validateAddress(result.address)).toBe(true);
    });
    
    it('should generate different addresses each time', () => {
      const result1 = generateAddress();
      const result2 = generateAddress();
      
      expect(result1.address).not.toBe(result2.address);
      expect(result1.publicKey).not.toBe(result2.publicKey);
      expect(result1.privateKey).not.toBe(result2.privateKey);
    });
    
    it('should generate addresses with different prefixes', () => {
      const mainnet = generateAddress(NetworkPrefix.MAINNET);
      const testnet = generateAddress(NetworkPrefix.TESTNET);
      
      expect(mainnet.address).not.toBe(testnet.address);
      // addresses for the same keys but different prefixes have different addresses
    });
  });

  describe('HD derivation', () => {
    it('should derive deterministic and distinct addresses', () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      const hdKey = createHDKey(mnemonic);

      const first = deriveKey(hdKey);
      const restored = deriveKey(createHDKey(mnemonic));
      const second = deriveKey(hdKey, { index: 1 });

      expect(restored).toEqual(first);
      expect(second.address).not.toBe(first.address);
    });
  });
  
  // Network prefix tests removed - constants defined locally in test file
});
