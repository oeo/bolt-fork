import { describe, it, expect } from 'bun:test';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
// import signature module first to ensure secp256k1 is configured
import {
  sign,
  verify,
  signTransaction,
  verifyTransaction,
  serializeTransactionData,
  calculateTransactionHash,
  generatePrivateKey,
  derivePublicKey,
  isValidPrivateKey,
  isValidPublicKey
} from '../../src/crypto/signature';

describe('Signature Functions', () => {
  
  describe('sign and verify', () => {
    it('should sign and verify message', async () => {
      const privateKey = generatePrivateKey();
      const publicKey = derivePublicKey(privateKey);
      const message = 'hello world';
      
      const signature = await sign(message, privateKey);
      expect(signature).toBeTruthy();
      expect(signature.length).toBe(128); // 64 bytes hex
      
      const isValid = await verify(message, signature, publicKey);
      expect(isValid).toBe(true);
    });
    
    it('should fail verification with wrong message', async () => {
      const privateKey = generatePrivateKey();
      const publicKey = derivePublicKey(privateKey);
      
      const signature = await sign('hello', privateKey);
      const isValid = await verify('goodbye', signature, publicKey);
      expect(isValid).toBe(false);
    });
    
    it('should fail verification with wrong public key', async () => {
      const privateKey1 = generatePrivateKey();
      const privateKey2 = generatePrivateKey();
      const publicKey2 = derivePublicKey(privateKey2);
      
      const signature = await sign('hello', privateKey1);
      const isValid = await verify('hello', signature, publicKey2);
      expect(isValid).toBe(false);
    });
    
    it('should handle hex string inputs', async () => {
      const privateKey = generatePrivateKey();
      const publicKey = derivePublicKey(privateKey);
      const message = 'test message';
      
      // sign with hex private key
      const signature = await sign(message, bytesToHex(privateKey));
      
      // verify with hex public key and signature
      const isValid = await verify(message, signature, bytesToHex(publicKey));
      expect(isValid).toBe(true);
    });
  });
  
  describe('transaction signing', () => {
    it('should sign and verify transaction', async () => {
      const privateKey = generatePrivateKey();
      const txData = {
        from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        amount: 1000000000n, // 10 BOLT
        nonce: 1,
        fee: 10000n,
        timestamp: Date.now()
      };
      
      const { signature, publicKey } = await signTransaction(txData, privateKey);
      expect(signature).toBeTruthy();
      expect(publicKey).toBeTruthy();
      
      const isValid = await verifyTransaction(txData, signature, publicKey);
      expect(isValid).toBe(true);
    });
    
    it('should fail verification with modified transaction data', async () => {
      const privateKey = generatePrivateKey();
      const txData = {
        from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: Date.now()
      };
      
      const { signature, publicKey } = await signTransaction(txData, privateKey);
      
      // modify amount
      const modifiedTx = { ...txData, amount: 2000000000n };
      const isValid = await verifyTransaction(modifiedTx, signature, publicKey);
      expect(isValid).toBe(false);
    });
  });
  
  describe('serializeTransactionData', () => {
    it('should serialize deterministically', () => {
      const txData = {
        from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      
      const serialized1 = serializeTransactionData(txData);
      const serialized2 = serializeTransactionData(txData);
      
      expect(serialized1).toBe(serialized2);
      expect(serialized1).toContain('1000000000');
      expect(serialized1).toContain('1234567890');
    });
  });
  
  describe('calculateTransactionHash', () => {
    it('should calculate consistent hash', () => {
      const txData = {
        from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      
      const hash1 = calculateTransactionHash(txData);
      const hash2 = calculateTransactionHash(txData);
      
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // sha256 hex
    });
    
    it('should include signature in hash if provided', () => {
      const txData = {
        from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      
      const hashWithoutSig = calculateTransactionHash(txData);
      const hashWithSig = calculateTransactionHash(txData, 'fakesignature');
      
      expect(hashWithoutSig).not.toBe(hashWithSig);
    });
    
    it('should handle coinbase transactions', () => {
      const coinbaseTx = {
        from: null,
        to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        amount: 5000000000n, // 50 BOLT reward
        nonce: 0,
        fee: 0n,
        timestamp: Date.now()
      };
      
      const hash = calculateTransactionHash(coinbaseTx);
      expect(hash).toBeTruthy();
      expect(hash.length).toBe(64);
    });
  });
  
  describe('key generation and validation', () => {
    it('should generate valid private key', () => {
      const privateKey = generatePrivateKey();
      expect(privateKey.length).toBe(32);
      expect(isValidPrivateKey(privateKey)).toBe(true);
    });
    
    it('should derive public key from private key', () => {
      const privateKey = generatePrivateKey();
      const publicKey = derivePublicKey(privateKey);
      
      expect(publicKey.length).toBe(33); // compressed
      expect(isValidPublicKey(publicKey)).toBe(true);
    });
    
    it('should validate private keys correctly', () => {
      const validKey = generatePrivateKey();
      expect(isValidPrivateKey(validKey)).toBe(true);
      expect(isValidPrivateKey(bytesToHex(validKey))).toBe(true);
      
      // invalid keys
      expect(isValidPrivateKey(new Uint8Array(32))).toBe(false); // all zeros
      expect(isValidPrivateKey('invalid')).toBe(false);
      expect(isValidPrivateKey(new Uint8Array(31))).toBe(false); // wrong length
    });
    
    it('should validate public keys correctly', () => {
      const privateKey = generatePrivateKey();
      const publicKey = derivePublicKey(privateKey);
      
      expect(isValidPublicKey(publicKey)).toBe(true);
      expect(isValidPublicKey(bytesToHex(publicKey))).toBe(true);
      
      // invalid keys
      expect(isValidPublicKey(new Uint8Array(32))).toBe(false); // wrong length
      expect(isValidPublicKey('invalid')).toBe(false);
    });
  });
});