import { describe, it, expect } from 'bun:test';
import {
  TransactionClass,
  createCoinbaseTransaction,
  createSignedTransaction,
  calculateMinimumFee,
  validateTransactionPool
} from '../../src/core/transaction';
import { generatePrivateKey, derivePublicKey } from '../../src/crypto/signature';
import { generateFromPrivateKey } from '../../src/crypto/address';

describe('Transaction Class', () => {
  const chainId = 1057;
  const addressPrefix = 0x00;
  const privateKey = generatePrivateKey();
  const publicKey = derivePublicKey(privateKey);
  const { address: senderAddress } = generateFromPrivateKey(privateKey);
  const recipientAddress = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
  
  describe('Regular transaction', () => {
    it('should create and sign transaction', async () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n, // 0.01 BOLT
        1,
        1000n,
        Date.now()
      );
      
      expect(tx.hash).toBe(''); // not yet signed
      
      await tx.sign(privateKey);
      
      expect(tx.hash).toBeTruthy();
      expect(tx.signature).toBeTruthy();
      expect(tx.publicKey).toBeTruthy();
    });
    
    it('should verify signed transaction', async () => {
      const tx = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        privateKey
      );
      
      const isValid = await tx.verify();
      expect(isValid).toBe(true);
    });
    
    it('should fail verification with tampered data', async () => {
      const tx = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        privateKey
      );
      
      // tamper with amount
      tx.amount = 2000000n;
      
      const isValid = await tx.verify();
      expect(isValid).toBe(false);
    });

    it('should reject a signature from a key that does not own sender address', async () => {
      const otherPrivateKey = generatePrivateKey();
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        Date.now()
      );

      await tx.sign(otherPrivateKey);

      expect(await tx.verify()).toBe(false);
      expect(tx.validate(chainId, addressPrefix).valid).toBe(false);
    });
    
    it('should validate correct transaction', async () => {
      const tx = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        privateKey
      );
      
      const result = tx.validate(chainId, addressPrefix);
      expect(result.valid).toBe(true);
    });

    it('should reject wrong chain ID', async () => {
      const tx = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        privateKey
      );

      const result = tx.validate(chainId + 1, addressPrefix);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('chain ID');
    });

    it('should reject wrong address prefix', async () => {
      const tx = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        privateKey
      );

      const result = tx.validate(chainId, 0x6f);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('address');
    });
    
    it('should reject unsigned regular transaction', () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        Date.now()
      );
      
      tx.hash = tx.calculateHash(); // set hash but no signature
      
      const result = tx.validate(chainId, addressPrefix);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signed');
    });
  });
  
  describe('Coinbase transaction', () => {
    it('should create coinbase transaction', () => {
      const coinbase = createCoinbaseTransaction(
        chainId,
        recipientAddress,
        5000000000n, // 50 BOLT
        3000n, // fees from other transactions
        Date.now()
      );
      
      expect(coinbase.from).toBeNull();
      expect(coinbase.chainId).toBe(chainId);
      expect(coinbase.kind).toBe('coinbase');
      expect(coinbase.to).toBe(recipientAddress);
      expect(coinbase.amount).toBe(5000003000n);
      expect(coinbase.nonce).toBe(0);
      expect(coinbase.fee).toBe(0n);
      expect(coinbase.hash).toBeTruthy();
    });
    
    it('should validate coinbase transaction', () => {
      const coinbase = createCoinbaseTransaction(
        chainId,
        recipientAddress,
        5000000000n,
        0n,
        Date.now()
      );
      
      const result = coinbase.validate(chainId, addressPrefix);
      expect(result.valid).toBe(true);
    });
    
    it('should reject coinbase with non-zero nonce', () => {
      const coinbase = new TransactionClass(
        chainId,
        null,
        recipientAddress,
        5000000000n,
        1, // invalid nonce
        0n,
        Date.now()
      );
      
      coinbase.hash = coinbase.calculateHash();
      
      const result = coinbase.validate(chainId, addressPrefix);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('nonce');
    });
    
    it('should reject coinbase with fee', () => {
      const coinbase = new TransactionClass(
        chainId,
        null,
        recipientAddress,
        5000000000n,
        0,
        1000n, // invalid fee
        Date.now()
      );
      
      coinbase.hash = coinbase.calculateHash();
      
      const result = coinbase.validate(chainId, addressPrefix);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('fee');
    });
    
    it('should not allow signing coinbase', async () => {
      const coinbase = createCoinbaseTransaction(
        chainId,
        recipientAddress,
        5000000000n,
        0n,
        Date.now()
      );
      
      let error: Error | null = null;
      try {
        await coinbase.sign(privateKey);
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeTruthy();
      expect(error?.message).toContain('coinbase');
    });
  });
  
  describe('Transaction validation', () => {
    it('should reject negative amounts', () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        -1000n, // negative
        1,
        1000n,
        Date.now()
      );
      
      const result = tx.validate(chainId, addressPrefix);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('amount');
    });
    
    it('should reject invalid addresses', () => {
      const tx = new TransactionClass(
        chainId,
        'invalid_address',
        recipientAddress,
        1000000n,
        1,
        1000n,
        Date.now()
      );
      
      const result = tx.validate(chainId, addressPrefix);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('address');
    });
    
    it('should reject future timestamps', async () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        Date.now() + (30 * 60 * 1000) // 30 minutes in future
      );
      
      // sign it first so we get past signature check
      await tx.sign(privateKey);
      
      const result = tx.validate(chainId, addressPrefix);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('future');
    });
  });
  
  describe('Account validation', () => {
    it('should validate against sufficient balance', () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        5, // transaction nonce
        1000n,
        Date.now()
      );
      
      const result = tx.validateAgainstAccount(
        2000000n, // sufficient balance
        5 // account's current nonce (next to be used)
      );
      
      expect(result.valid).toBe(true);
    });
    
    it('should reject insufficient balance', () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        5,
        1000n,
        Date.now()
      );
      
      const result = tx.validateAgainstAccount(
        500000n, // insufficient
        4
      );
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('balance');
    });
    
    it('should reject invalid nonce', () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        5,
        1000n,
        Date.now()
      );
      
      const result = tx.validateAgainstAccount(
        2000000n,
        10 // wrong nonce
      );
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('nonce');
    });
    
    it('should skip account validation for coinbase', () => {
      const coinbase = createCoinbaseTransaction(
        chainId,
        recipientAddress,
        5000000000n,
        0n,
        Date.now()
      );
      
      const result = coinbase.validateAgainstAccount(0n, 0);
      expect(result.valid).toBe(true);
    });
  });
  
  describe('Serialization', () => {
    it('should serialize and deserialize', async () => {
      const tx = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        privateKey
      );
      
      const serialized = tx.serialize();
      const deserialized = TransactionClass.deserialize(serialized);
      
      expect(deserialized.hash).toBe(tx.hash);
      expect(deserialized.chainId).toBe(chainId);
      expect(deserialized.kind).toBe('transfer');
      expect(deserialized.from).toBe(tx.from);
      expect(deserialized.to).toBe(tx.to);
      expect(deserialized.amount).toBe(tx.amount);
      expect(deserialized.signature).toBe(tx.signature);
    });
    
    it('should convert between object and class', () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        Date.now()
      );
      
      const obj = tx.toObject();
      const restored = TransactionClass.fromObject(obj);
      
      expect(restored.from).toBe(tx.from);
      expect(restored.chainId).toBe(chainId);
      expect(restored.kind).toBe('transfer');
      expect(restored.to).toBe(tx.to);
      expect(restored.amount).toBe(tx.amount);
    });

    it('should reject legacy transaction objects', () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n
      ).toObject();

      expect(() => TransactionClass.fromObject({ ...tx, chainId: undefined } as any)).toThrow('chain ID');
      expect(() => TransactionClass.fromObject({ ...tx, kind: undefined } as any)).toThrow('kind');
    });
  });
  
  describe('Transaction pool validation', () => {
    it('should validate clean pool', async () => {
      const tx1 = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        privateKey
      );
      
      const tx2 = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        2000000n,
        2,
        2000n,
        privateKey
      );
      
      const result = validateTransactionPool([tx1, tx2]);
      expect(result.valid).toBe(true);
    });
    
    it('should reject duplicate transactions', async () => {
      const tx = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        privateKey
      );
      
      const result = validateTransactionPool([tx, tx]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Duplicate transaction');
    });
    
    it('should reject duplicate nonces', async () => {
      const tx1 = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        privateKey
      );
      
      const tx2 = await createSignedTransaction(
        chainId,
        senderAddress,
        recipientAddress,
        2000000n,
        1, // same nonce!
        2000n,
        privateKey,
        Date.now() + 1000
      );
      
      const result = validateTransactionPool([tx1, tx2]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Duplicate nonce');
    });
  });
  
  describe('Utility methods', () => {
    it('should identify coinbase', () => {
      const coinbase = createCoinbaseTransaction(
        chainId,
        recipientAddress,
        5000000000n,
        0n,
        Date.now()
      );
      
      const regular = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        Date.now()
      );
      
      expect(coinbase.isCoinbase()).toBe(true);
      expect(regular.isCoinbase()).toBe(false);
    });
    
    it('should calculate minimum fee', () => {
      const fee = calculateMinimumFee(250, 2n); // 250 bytes, 2 satoshi per byte
      expect(fee).toBe(500n);
    });
    
    it('should get transaction size', () => {
      const tx = new TransactionClass(
        chainId,
        senderAddress,
        recipientAddress,
        1000000n,
        1,
        1000n,
        Date.now()
      );
      
      const size = tx.getSize();
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(1000); // reasonable size
    });
  });
});
