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
  isValidPublicKey,
  type TransactionData
} from '../../src/crypto/signature';

describe('Signature Functions', () => {
  const chainId = 1057;
  const senderAddress = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const recipientAddress = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
  
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
      const txData: TransactionData = {
        chainId,
        kind: 'transfer',
        from: senderAddress,
        to: recipientAddress,
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
      const txData: TransactionData = {
        chainId,
        kind: 'transfer',
        from: senderAddress,
        to: recipientAddress,
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

    it('should bind signatures and hashes to chain ID', async () => {
      const privateKey = generatePrivateKey();
      const txData: TransactionData = {
        chainId,
        kind: 'transfer',
        from: senderAddress,
        to: recipientAddress,
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      const otherChainTx = { ...txData, chainId: chainId + 1 };

      const signed = await signTransaction(txData, privateKey);
      const otherChainSigned = await signTransaction(otherChainTx, privateKey);

      expect(otherChainSigned.signature).not.toBe(signed.signature);
      expect(calculateTransactionHash(otherChainTx)).not.toBe(calculateTransactionHash(txData));
      expect(await verifyTransaction(otherChainTx, signed.signature, signed.publicKey)).toBe(false);
    });

    it('should preserve canonical signed transaction vectors', async () => {
      const txData: TransactionData = {
        chainId,
        kind: 'transfer',
        from: senderAddress,
        to: recipientAddress,
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      const signed = await signTransaction(txData, `${'00'.repeat(31)}01`);

      expect(signed.publicKey).toBe('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
      expect(signed.signature).toBe(
        '26ace33ed5e8c96a9749b0bc2f52292af7c3784ed44879629cdeac8b48bcf279' +
        '194c1063bd5b869a8ac895e1d060cc6652266b315a72e71772b79cf155b09703'
      );
      expect(calculateTransactionHash(txData, signed.signature, signed.publicKey)).toBe(
        'd377d781de48947526d4139cc31488499ad2657db8253baa14c4c88daf490c8f'
      );
    });
  });
  
  describe('serializeTransactionData', () => {
    it('should serialize deterministically', () => {
      const txData: TransactionData = {
        chainId,
        kind: 'transfer',
        from: senderAddress,
        to: recipientAddress,
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      
      const serialized1 = serializeTransactionData(txData);
      const serialized2 = serializeTransactionData(txData);
      
      expect(serialized1).toEqual(serialized2);
      expect(bytesToHex(serialized1)).toBe(
        '0000000900000013626f6c743a7472616e73616374696f6e3a76310000000431303537' +
        '000000087472616e73666572000000223141317a5031655035514765666932444d505466' +
        '544c35534c6d7637446976664e6100000022314276424d53455973745765747154466e35' +
        '4175346d3447466737784a614e564e320000000a313030303030303030300000000131' +
        '0000000531303030300000000a31323334353637383930'
      );
      const content = new TextDecoder().decode(serialized1);
      expect(content).toContain(chainId.toString());
      expect(content).toContain('transfer');
      expect(content).toContain('1000000000');
      expect(content).toContain('1234567890');
    });
  });
  
  describe('calculateTransactionHash', () => {
    it('should calculate consistent hash', () => {
      const txData: TransactionData = {
        chainId,
        kind: 'transfer',
        from: senderAddress,
        to: recipientAddress,
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      
      const hash1 = calculateTransactionHash(txData);
      const hash2 = calculateTransactionHash(txData);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toBe('aaace1a1335bb204f989d49b3f6f92672d5b6ca0d88a8e5caa1519cdaab32868');
      expect(hash1.length).toBe(64); // sha256 hex
    });
    
    it('should include signature in hash if provided', () => {
      const txData: TransactionData = {
        chainId,
        kind: 'transfer',
        from: senderAddress,
        to: recipientAddress,
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      
      const hashWithoutSig = calculateTransactionHash(txData);
      const hashWithSig = calculateTransactionHash(txData, 'ab'.repeat(64), `02${'11'.repeat(32)}`);

      expect(hashWithoutSig).not.toBe(hashWithSig);
    });

    it('should commit the canonical public key into signed hashes', () => {
      const txData: TransactionData = {
        chainId,
        kind: 'transfer',
        from: senderAddress,
        to: recipientAddress,
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      const signature = 'ab'.repeat(64);

      expect(calculateTransactionHash(txData, signature, `02${'11'.repeat(32)}`)).not.toBe(
        calculateTransactionHash(txData, signature, `03${'11'.repeat(32)}`)
      );
    });

    it('should hash signature bytes independent of hex casing', () => {
      const txData = {
        chainId,
        kind: 'transfer' as const,
        from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        amount: 1000000000n,
        nonce: 1,
        fee: 10000n,
        timestamp: 1234567890
      };
      const signature = 'ab'.repeat(64);

      const publicKey = `02${'11'.repeat(32)}`;
      expect(calculateTransactionHash(txData, signature, publicKey)).toBe(
        calculateTransactionHash(txData, signature.toUpperCase(), publicKey)
      );
    });
    
    it('should handle coinbase transactions', () => {
      const coinbaseTx: TransactionData = {
        chainId,
        kind: 'coinbase',
        from: null,
        to: senderAddress,
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
