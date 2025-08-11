// bun worker script for cpu-intensive tasks
// uses bun's native Worker API with self/postMessage
// self-contained to avoid import issues in worker context

// worker identification
let workerId = 0;

// inline merkle root calculation to avoid imports
function calculateMerkleRoot(transactions: any[]): string {
  if (!transactions || transactions.length === 0) {
    return '0'.repeat(64);
  }
  
  // simplified merkle root - just hash all transaction hashes together
  const hasher = new Bun.CryptoHasher('sha256');
  for (const tx of transactions) {
    hasher.update(tx.hash || '');
  }
  return hasher.digest().toString('hex');
}

// task handlers
const taskHandlers = {
  validate_block: async (data: any) => {
    const block = data.block;
    
    // validate block structure
    if (!block.hash || !block.previousHash || !block.merkleRoot) {
      throw new Error('invalid block structure');
    }
    
    // validate proof of work
    const hashBuffer = Buffer.from(block.hash, 'hex');
    const leadingZeros = countLeadingZeros(hashBuffer);
    if (leadingZeros < block.difficulty) {
      throw new Error('insufficient proof of work');
    }
    
    // validate merkle root
    const calculatedRoot = calculateMerkleRoot(block.transactions);
    if (calculatedRoot !== block.merkleRoot) {
      throw new Error('invalid merkle root');
    }
    
    // validate timestamps
    const now = Date.now();
    if (block.timestamp > now + 120000) { // 2 minutes future tolerance
      throw new Error('block timestamp too far in future');
    }
    
    return { valid: true };
  },

  verify_transaction: async (data: any) => {
    const tx = data.transaction;
    
    // verify transaction structure
    if (!tx.hash || !tx.from || !tx.to) {
      throw new Error('invalid transaction structure');
    }
    
    if (tx.amount <= 0n) {
      throw new Error('invalid transaction amount');
    }
    
    if (tx.fee < 0n) {
      throw new Error('invalid transaction fee');
    }
    
    // signature verification would go here
    // for now, just check that signature exists
    if (!tx.signature) {
      throw new Error('missing transaction signature');
    }
    
    return { valid: true };
  },

  mine_block: async (data: any) => {
    const block = data.block;
    const difficulty = data.difficulty;
    const maxIterations = data.maxIterations || 1000000;
    
    // mine block using bun's CryptoHasher
    let nonce = 0;
    let hash = '';
    
    for (let i = 0; i < maxIterations; i++) {
      nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      
      // calculate hash using bun's native hasher
      const blockData = `${block.index}${block.previousHash}${block.timestamp}${block.merkleRoot}${difficulty}${nonce}`;
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(blockData);
      const hashBuffer = hasher.digest();
      hash = hashBuffer.toString('hex');
      
      // check if it meets difficulty
      const leadingZeros = countLeadingZeros(hashBuffer);
      if (leadingZeros >= difficulty) {
        return {
          found: true,
          nonce,
          hash,
          iterations: i + 1,
        };
      }
    }
    
    return {
      found: false,
      iterations: maxIterations,
    };
  },

  calculate_merkle: async (data: any) => {
    const transactions = data.transactions || [];
    const root = calculateMerkleRoot(transactions);
    return { root };
  },

  verify_signature: async (data: any) => {
    const { publicKey, signature, message } = data;
    
    // simplified signature verification
    // in production, would use proper crypto verification
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(message);
    const messageHash = hasher.digest().toString('hex');
    
    // for now, just check that signature is present
    const isValid = signature && publicKey && messageHash;
    
    return { valid: !!isValid };
  },
};

// helper function to count leading zeros
function countLeadingZeros(buffer: Uint8Array): number {
  let zeros = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      zeros += 8;
    } else {
      // count leading zeros in byte
      let mask = 0x80;
      while ((byte & mask) === 0 && mask > 0) {
        zeros++;
        mask >>= 1;
      }
      break;
    }
  }
  return zeros;
}

// message handler for bun Worker
self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  
  if (message.type === 'init') {
    workerId = message.workerId;
    console.log(`worker ${workerId} initialized`);
    return;
  }
  
  if (message.type === 'task') {
    const { task } = message;
    
    try {
      // execute task
      const handler = taskHandlers[task.type];
      if (!handler) {
        throw new Error(`unknown task type: ${task.type}`);
      }
      
      const result = await handler(task.data);
      
      // send result back
      self.postMessage({
        type: 'result',
        taskId: task.id,
        success: true,
        result,
      });
    } catch (error: any) {
      // send error back
      self.postMessage({
        type: 'result',
        taskId: task.id,
        success: false,
        error: error.message,
      });
    }
  }
};