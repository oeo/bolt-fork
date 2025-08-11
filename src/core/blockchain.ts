import { EventEmitter } from 'events';
import { Block, Transaction, AccountState, StorageAdapter, BlockTemplate, ValidationResult } from '../types';
import { ChainConfig } from '../config/chain';
import { BlockClass, createGenesisBlock } from './block';
import { TransactionClass, createCoinbaseTransaction, validateTransactionPool } from './transaction';
import { getDifficultyAdjustment, shouldAdjustDifficulty, DifficultyConfig, calculateCumulativeDifficulty } from './difficulty';
import { HashAlgorithm, hash } from '../crypto/hash';
import { ForkManager } from './fork-manager';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

/**
 * main blockchain orchestration class
 */
export class Blockchain extends EventEmitter {
  private storage: StorageAdapter;
  private config: ChainConfig;
  private hashAlgorithm: HashAlgorithm;
  private difficultyConfig: DifficultyConfig;
  private currentHeight: number = -1;
  private isInitialized: boolean = false;
  private forkManager: ForkManager;

  constructor(
    storage: StorageAdapter,
    config: ChainConfig,
    hashAlgorithm: HashAlgorithm = 'sha256'
  ) {
    super();
    this.storage = storage;
    this.config = config;
    this.hashAlgorithm = hashAlgorithm;
    this.forkManager = new ForkManager();

    // setup difficulty config from chain config
    this.difficultyConfig = {
      adjustmentInterval: config.difficultyAdjustmentInterval,
      targetBlockTime: config.targetBlockTime,
      maxAdjustmentFactor: 4,
      minDifficulty: config.minDifficulty
    };
  }

  /**
   * initialize blockchain (create genesis if needed)
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Blockchain already initialized');
      return;
    }

    logger.info(`Initializing blockchain for network: ${this.config.name}`);

    // ensure storage is connected
    // @ts-ignore - accessing protected property for connection check
    if (!this.storage['isConnected']) {
      await this.storage.connect();
    }

    // check for existing blockchain
    const latestBlock = await this.storage.getLatestBlock();

    if (latestBlock) {

      this.currentHeight = latestBlock.index;
      logger.info(`Blockchain loaded at height ${this.currentHeight}`);
    } else {
      // create genesis block
      await this.createGenesis();
    }

    this.isInitialized = true;
  }

  /**
   * create and save genesis block
   */
  private async createGenesis(): Promise<void> {
    logger.info('Creating genesis block');

    const genesis = createGenesisBlock(
      this.config.initialDifficulty,
      this.config.genesisTimestamp || Date.now(),
      this.hashAlgorithm
    );

    // save to storage
    await this.storage.saveBlock(genesis.toObject());
    await this.storage.updateCumulativeDifficulty(BigInt(genesis.difficulty));

    this.currentHeight = 0;

    logger.info(`Genesis block created: ${genesis.hash}`);
  }

  /**
   * add a new block to the blockchain
   */
  async addBlock(block: BlockClass): Promise<ValidationResult> {
    if (!this.isInitialized) {
      throw new Error('Blockchain not initialized');
    }

    logger.debug(`Adding block ${block.index} to blockchain`);

    // validate block structure
    const structureValidation = block.validate(this.hashAlgorithm);
    if (!structureValidation.valid) {
      return structureValidation;
    }

    // check if block already exists at this height
    const existingBlock = await this.storage.getBlock(block.index);
    if (existingBlock) {
      // block already exists at this height - this is a fork
      if (existingBlock.hash === block.hash) {
        // same block, already have it
        logger.debug(`Block ${block.index} already exists with same hash`);
        return { valid: true };
      }
      // different block at same height - need to handle as competing block
      logger.warn(`Different block at height ${block.index}, handling as competing block`);
      return await this.handleCompetingBlock(block);
    }

    // get previous block
    const previousBlock = await this.storage.getBlock(block.index - 1);
    if (!previousBlock) {
      return { valid: false, error: 'Previous block not found' };
    }

    const prevBlockClass = BlockClass.fromObject(previousBlock);

    // validate against previous block
    const prevValidation = block.validatePreviousBlock(prevBlockClass);
    if (!prevValidation.valid) {
      return prevValidation;
    }

    // validate median time
    const pastBlocks = await this.getPastBlocks(11);
    const medianValidation = block.validateMedianTime(pastBlocks);
    if (!medianValidation.valid) {
      return medianValidation;
    }

    // validate difficulty
    const expectedDifficulty = await this.getDifficulty(block.index);
    const difficultyValidation = block.validateDifficulty(expectedDifficulty);
    if (!difficultyValidation.valid) {
      return difficultyValidation;
    }

    // validate coinbase
    const blockReward = this.getBlockReward(block.index);
    const coinbaseValidation = block.validateCoinbase(blockReward);
    if (!coinbaseValidation.valid) {
      return coinbaseValidation;
    }

    // validate all transactions
    const txValidation = await this.validateBlockTransactions(block);
    if (!txValidation.valid) {
      return txValidation;
    }

    // process transactions and update state
    await this.processBlockTransactions(block);

    // save block to storage
    await this.storage.saveBlock(block.toObject());

    // update cumulative difficulty
    const currentCumulative = await this.storage.getCumulativeDifficulty();
    const newCumulative = currentCumulative + BigInt(block.difficulty);
    await this.storage.updateCumulativeDifficulty(newCumulative);

    // update current height
    this.currentHeight = block.index;

    logger.info(`Block ${block.index} added successfully`);

    // emit event with block details for metrics recording
    this.emit('blockAdded', block);

    return { valid: true };
  }

  /**
   * validate all transactions in a block
   */
  private async validateBlockTransactions(block: BlockClass): Promise<ValidationResult> {
    const transactions = block.transactions.map(tx => TransactionClass.fromObject(tx));

    // check for duplicate transactions
    const poolValidation = validateTransactionPool(transactions);
    if (!poolValidation.valid) {
      return poolValidation;
    }

    // track temporary state changes for validation
    const tempStateChanges = new Map<string, { balance: bigint; nonce: number }>();

    // validate each transaction
    for (const tx of transactions) {
      // validate structure
      const txValidation = tx.validate();
      if (!txValidation.valid) {
        return { valid: false, error: `Transaction ${tx.hash}: ${txValidation.error}` };
      }

      // verify signature
      const isValid = await tx.verify();
      if (!isValid && !tx.isCoinbase()) {
        return { valid: false, error: `Transaction ${tx.hash}: Invalid signature` };
      }

      // validate against account state (skip coinbase)
      if (!tx.isCoinbase()) {
        // get current or temporary state
        let accountState = tempStateChanges.get(tx.from!);
        if (!accountState) {
          const storedState = await this.storage.getAccountState(tx.from!);
          if (!storedState) {
            return { valid: false, error: `Transaction ${tx.hash}: Sender account not found` };
          }
          accountState = { ...storedState };
        }

        const accountValidation = tx.validateAgainstAccount(
          accountState.balance,
          accountState.nonce
        );
        if (!accountValidation.valid) {
          return { valid: false, error: `Transaction ${tx.hash}: ${accountValidation.error}` };
        }

        // update temporary state
        accountState.balance -= (tx.amount + tx.fee);
        accountState.nonce++;
        tempStateChanges.set(tx.from!, accountState);
      }
    }

    return { valid: true };
  }

  /**
   * process transactions and update account states
   */
  private async processBlockTransactions(block: BlockClass): Promise<void> {
    logger.debug(`Processing ${block.transactions.length} transactions in block ${block.index}`);

    for (const txData of block.transactions) {
      const tx = TransactionClass.fromObject(txData);

      // save transaction
      await this.storage.saveTransaction(txData);

      if (tx.isCoinbase()) {
        // credit miner
        const minerState = await this.storage.getAccountState(tx.to) || {
          balance: 0n,
          nonce: 0
        };

        minerState.balance += tx.amount;
        await this.storage.updateAccountState(tx.to, minerState);

        logger.debug(`Credited miner ${tx.to} with ${tx.amount} satoshis`);
      } else {
        // debit sender
        const senderState = await this.storage.getAccountState(tx.from!);
        if (!senderState) {
          throw new Error(`Sender account ${tx.from} not found`);
        }

        senderState.balance -= (tx.amount + tx.fee);
        senderState.nonce++;
        await this.storage.updateAccountState(tx.from!, senderState);

        // credit recipient
        const recipientState = await this.storage.getAccountState(tx.to) || {
          balance: 0n,
          nonce: 0
        };

        recipientState.balance += tx.amount;
        await this.storage.updateAccountState(tx.to, recipientState);

        logger.debug(`Transferred ${tx.amount} satoshis from ${tx.from} to ${tx.to}`);
      }
    }
  }

  /**
   * get current difficulty for mining
   */
  async getDifficulty(blockHeight?: number): Promise<number> {
    const height = blockHeight ?? this.currentHeight + 1;

    // use difficulty adjustment algorithm
    const difficulty = await getDifficultyAdjustment(
      height,
      async (h) => this.storage.getBlock(h),
      this.difficultyConfig
    );

    return difficulty;
  }

  /**
   * get block reward for a given height
   */
  getBlockReward(blockHeight: number): bigint {
    // calculate halvings
    const halvings = Math.floor(blockHeight / this.config.halvingInterval);

    // initial reward
    let reward = this.config.initialReward;

    // apply halvings
    for (let i = 0; i < halvings; i++) {
      reward = reward / 2n;

      // stop at minimum reward (1 satoshi)
      if (reward < 1n) {
        reward = 1n;
        break;
      }
    }

    // check max supply
    const totalSupply = this.calculateTotalSupply(blockHeight);
    if (totalSupply + reward > this.config.maxSupply) {
      // adjust reward to not exceed max supply
      reward = this.config.maxSupply - totalSupply;
      if (reward < 0n) {
        reward = 0n;
      }
    }

    return reward;
  }

  /**
   * calculate total supply up to a given height
   */
  private calculateTotalSupply(blockHeight: number): bigint {
    let totalSupply = 0n;
    let currentReward = this.config.initialReward;
    let nextHalving = this.config.halvingInterval;

    for (let height = 0; height <= blockHeight; height++) {
      if (height >= nextHalving) {
        currentReward = currentReward / 2n;
        if (currentReward < 1n) {
          currentReward = 1n;
        }
        nextHalving += this.config.halvingInterval;
      }

      totalSupply += currentReward;

      // stop if max supply reached
      if (totalSupply >= this.config.maxSupply) {
        return this.config.maxSupply;
      }
    }

    return totalSupply;
  }

  /**
   * get account balance in satoshis
   */
  async getBalance(address: string): Promise<bigint> {
    const accountState = await this.storage.getAccountState(address);
    return accountState?.balance ?? 0n;
  }

  /**
   * get account nonce
   */
  async getNonce(address: string): Promise<number> {
    const accountState = await this.storage.getAccountState(address);
    return accountState?.nonce ?? 0;
  }

  /**
   * get cumulative difficulty of the chain
   */
  async getCumulativeDifficulty(): Promise<bigint> {
    return this.storage.getCumulativeDifficulty();
  }

  /**
   * get latest block
   */
  async getLatestBlock(): Promise<Block | null> {
    return this.storage.getLatestBlock();
  }

  /**
   * get block by height
   */
  async getBlock(height: number): Promise<Block | null> {
    return this.storage.getBlock(height);
  }

  /**
   * get block by hash
   */
  async getBlockByHash(hash: string): Promise<Block | null> {
    return this.storage.getBlockByHash(hash);
  }

  /**
   * get current blockchain height
   */
  async getHeight(): Promise<number> {
    const latestBlock = await this.getLatestBlock();
    return latestBlock ? latestBlock.index : -1;
  }

  /**
   * iterate through entire blockchain
   */
  async* iterateChain(): AsyncGenerator<Block> {
    for (let height = 0; height <= this.currentHeight; height++) {
      const block = await this.storage.getBlock(height);
      if (block) {
        yield block;
      }
    }
  }

  /**
   * calculate all balances by iterating the chain
   */
  async calculateAllBalances(): Promise<Map<string, bigint>> {
    logger.info('Calculating all balances from chain history');

    const balances = new Map<string, bigint>();

    // iterate through all blocks
    for await (const block of this.iterateChain()) {
      for (const tx of block.transactions) {
        const transaction = TransactionClass.fromObject(tx);

        if (transaction.isCoinbase()) {
          // credit miner
          const current = balances.get(transaction.to) ?? 0n;
          balances.set(transaction.to, current + transaction.amount);
        } else {
          // debit sender
          const senderBalance = balances.get(transaction.from!) ?? 0n;
          balances.set(transaction.from!, senderBalance - (transaction.amount + transaction.fee));

          // credit recipient
          const recipientBalance = balances.get(transaction.to) ?? 0n;
          balances.set(transaction.to, recipientBalance + transaction.amount);
        }
      }
    }

    logger.info(`Calculated balances for ${balances.size} addresses`);

    return balances;
  }

  /**
   * verify chain integrity
   */
  async verifyChainIntegrity(): Promise<ValidationResult> {
    logger.info('Verifying chain integrity');

    let previousBlock: Block | null = null;
    let cumulativeDifficulty = 0n;

    for await (const block of this.iterateChain()) {
      const blockClass = BlockClass.fromObject(block);

      // validate block structure
      const validation = blockClass.validate(this.hashAlgorithm);
      if (!validation.valid) {
        return { valid: false, error: `Block ${block.index}: ${validation.error}` };
      }

      // validate against previous block (skip genesis)
      if (previousBlock && block.index > 0) {
        const prevBlockClass = BlockClass.fromObject(previousBlock);
        const prevValidation = blockClass.validatePreviousBlock(prevBlockClass);
        if (!prevValidation.valid) {
          return { valid: false, error: `Block ${block.index}: ${prevValidation.error}` };
        }
      }

      // accumulate difficulty
      cumulativeDifficulty += BigInt(block.difficulty);

      previousBlock = block;
    }

    // verify cumulative difficulty matches
    const storedCumulative = await this.storage.getCumulativeDifficulty();
    if (storedCumulative !== cumulativeDifficulty) {
      return {
        valid: false,
        error: `Cumulative difficulty mismatch: stored=${storedCumulative}, calculated=${cumulativeDifficulty}`
      };
    }

    logger.info('Chain integrity verified successfully');

    return { valid: true };
  }

  /**
   * select best chain based on cumulative difficulty
   */
  async selectBestChain(
    candidateBlocks: Block[],
    candidateCumulativeDifficulty: bigint
  ): Promise<boolean> {
    const currentCumulative = await this.getCumulativeDifficulty();

    logger.info(
      `Comparing chains: current=${currentCumulative}, candidate=${candidateCumulativeDifficulty}`
    );

    // select chain with highest cumulative difficulty
    if (candidateCumulativeDifficulty > currentCumulative) {
      logger.info('Candidate chain has higher cumulative difficulty, switching...');

      // TODO: implement chain reorganization
      // This would involve:
      // 1. Finding common ancestor
      // 2. Rolling back current chain to common ancestor
      // 3. Applying new blocks from candidate chain
      // 4. Re-processing all transactions

      return true;
    } else if (candidateCumulativeDifficulty === currentCumulative) {
      // when equal, keep current (first seen wins)
      logger.info('Chains have equal difficulty, keeping current');
      return false;
    } else {
      logger.info('Current chain has higher difficulty, keeping current');
      return false;
    }
  }

  /**
   * handle a competing block that may trigger reorganization
   */
  async handleCompetingBlock(block: BlockClass, peerId?: string): Promise<ValidationResult> {
    logger.info(`Handling competing block ${block.index} with hash ${block.hash}`);
    
    // check if this block extends a known fork
    const fork = this.forkManager.updateFork(block.previousHash, block.toObject(), peerId);
    
    if (!fork) {
      // new fork or orphan block
      const previousBlock = await this.storage.getBlockByHash(block.previousHash);
      if (previousBlock) {
        // new fork starting from our chain
        const forkBase = await this.storage.getBlock(previousBlock.index);
        if (forkBase) {
          const forkCumulativeDifficulty = await this.storage.getCumulativeDifficulty() - 
            BigInt(forkBase.difficulty) + BigInt(block.difficulty);
          this.forkManager.addFork(block.toObject(), forkCumulativeDifficulty, peerId);
        }
      } else {
        // orphan block
        this.forkManager.addOrphan(block.toObject());
        return { valid: false, error: 'Orphan block, parent not found' };
      }
    }
    
    // check if this fork should trigger reorganization
    const ourCumulativeDifficulty = await this.getCumulativeDifficulty();
    const ourLatestBlock = await this.getLatestBlock();
    const bestFork = this.forkManager.getBestFork();
    
    if (bestFork) {
      const comparison = this.forkManager.compareFork(
        bestFork, 
        this.currentHeight, 
        ourCumulativeDifficulty,
        ourLatestBlock?.hash
      );
      
      if (comparison.shouldReorganize) {
        logger.warn(`Fork should trigger reorganization: work ${bestFork.cumulativeDifficulty} vs ${ourCumulativeDifficulty}, hash ${bestFork.tipHash} vs ${ourLatestBlock?.hash}`);
        
        // find common ancestor
        const commonAncestorHeight = await this.findCommonAncestor(bestFork.blocks);
        
        if (commonAncestorHeight >= 0) {
          // trigger reorganization
          const success = await this.reorganize(commonAncestorHeight, bestFork.blocks);
          if (success) {
            this.forkManager.removeFork(bestFork.tipHash);
            return { valid: true };
          }
        }
      }
    }
    
    return { valid: false, error: 'Block on competing chain with less work' };
  }
  
  /**
   * find common ancestor between our chain and fork
   */
  async findCommonAncestor(forkBlocks: Block[]): Promise<number> {
    // start from the earliest block in the fork
    const earliestForkBlock = forkBlocks[0];
    
    // check if fork's previous block exists in our chain
    const previousBlock = await this.storage.getBlockByHash(earliestForkBlock.previousHash);
    if (previousBlock) {
      return previousBlock.index;
    }
    
    // if not found, we need more blocks from the fork to find common ancestor
    logger.warn('Cannot find common ancestor, need more fork history');
    return -1;
  }

  /**
   * reorganize blockchain from a specific height
   */
  async reorganize(commonAncestorHeight: number, newBlocks: Block[]): Promise<boolean> {
    logger.warn(`Starting chain reorganization from height ${commonAncestorHeight}`);
    
    try {
      // calculate cumulative difficulty of new chain segment
      let newSegmentDifficulty = 0n;
      for (const block of newBlocks) {
        newSegmentDifficulty += BigInt(block.difficulty);
      }
      
      // calculate current chain segment difficulty
      let currentSegmentDifficulty = 0n;
      for (let height = commonAncestorHeight + 1; height <= this.currentHeight; height++) {
        const block = await this.storage.getBlock(height);
        if (block) {
          currentSegmentDifficulty += BigInt(block.difficulty);
        }
      }
      
      // verify new chain has more work
      if (newSegmentDifficulty <= currentSegmentDifficulty) {
        logger.warn('New chain does not have more work, aborting reorganization');
        return false;
      }
      
      // pre-validate entire new chain before applying
      logger.info(`Pre-validating ${newBlocks.length} new blocks`);
      const validationResult = await this.validateReorgChain(commonAncestorHeight, newBlocks);
      if (!validationResult.valid) {
        logger.error(`New chain validation failed: ${validationResult.error}`);
        return false;
      }
      
      // rollback to common ancestor
      logger.info(`Rolling back from height ${this.currentHeight} to ${commonAncestorHeight}`);
      
      // collect all transactions from blocks being removed
      const removedTransactions: Transaction[] = [];
      for (let height = this.currentHeight; height > commonAncestorHeight; height--) {
        const block = await this.storage.getBlock(height);
        if (block) {
          // skip coinbase transactions
          removedTransactions.push(...block.transactions.filter(tx => tx.from !== null));
        }
      }
      
      // reset chain height
      this.currentHeight = commonAncestorHeight;
      
      // recalculate account states up to common ancestor
      await this.recalculateStateFromHeight(0, commonAncestorHeight);
      
      // apply new blocks using special reorg mode
      logger.info(`Applying ${newBlocks.length} new blocks`);
      for (let i = 0; i < newBlocks.length; i++) {
        const block = newBlocks[i];
        const blockClass = block instanceof BlockClass ? block : BlockClass.fromObject(block);
        
        // use special add method that considers already validated chain
        const result = await this.addBlockDuringReorg(blockClass, newBlocks.slice(0, i));
        if (!result.valid) {
          logger.error(`Failed to apply block ${block.index} during reorg: ${result.error}`);
          throw new Error(`Reorganization failed: ${result.error}`);
        }
      }
      
      // re-add removed transactions to mempool (if they're still valid)
      logger.info(`Re-adding ${removedTransactions.length} transactions to mempool`);
      for (const tx of removedTransactions) {
        try {
          // check if transaction is still valid with new state
          const balance = await this.getBalance(tx.from!);
          const nonce = await this.getNonce(tx.from!);
          
          const txClass = TransactionClass.fromObject(tx);
          const validation = txClass.validateAgainstAccount(balance, nonce);
          
          if (validation.valid) {
            // re-add to mempool if we have one
            // note: mempool integration would go here
            logger.debug(`Re-added transaction ${tx.hash} to mempool`);
          } else {
            logger.debug(`Transaction ${tx.hash} no longer valid: ${validation.error}`);
          }
        } catch (error) {
          logger.debug(`Failed to re-add transaction ${tx.hash}`, error);
        }
      }
      
      logger.info(`Chain reorganization completed, new height=${this.currentHeight}`);
      return true;
      
    } catch (error) {
      logger.error('Chain reorganization failed', error);
      throw error;
    }
  }
  
  /**
   * validate entire competing chain before reorganization
   */
  private async validateReorgChain(
    commonAncestorHeight: number,
    newBlocks: Block[]
  ): Promise<ValidationResult> {
    // get blocks up to common ancestor for median time validation
    const ancestorBlocks: BlockClass[] = [];
    for (let height = Math.max(0, commonAncestorHeight - 10); height <= commonAncestorHeight; height++) {
      const block = await this.storage.getBlock(height);
      if (block) {
        ancestorBlocks.push(BlockClass.fromObject(block));
      }
    }
    
    // validate each block in the new chain
    for (let i = 0; i < newBlocks.length; i++) {
      const block = newBlocks[i];
      const blockClass = block instanceof BlockClass ? block : BlockClass.fromObject(block);
      
      // validate block structure
      const structureValidation = blockClass.validate(this.hashAlgorithm);
      if (!structureValidation.valid) {
        return { valid: false, error: `Block ${block.index}: ${structureValidation.error}` };
      }
      
      // validate against previous block
      const prevBlock = i === 0
        ? await this.storage.getBlock(commonAncestorHeight)
        : newBlocks[i - 1];
      
      if (!prevBlock) {
        return { valid: false, error: `Block ${block.index}: Previous block not found` };
      }
      
      const prevBlockClass = prevBlock instanceof BlockClass
        ? prevBlock
        : BlockClass.fromObject(prevBlock);
      
      const prevValidation = blockClass.validatePreviousBlock(prevBlockClass);
      if (!prevValidation.valid) {
        return { valid: false, error: `Block ${block.index}: ${prevValidation.error}` };
      }
      
      // validate median time using correct past blocks
      const pastBlocksForMedian = this.getPastBlocksForReorg(
        ancestorBlocks,
        newBlocks.slice(0, i),
        11
      );
      
      const medianValidation = blockClass.validateMedianTime(pastBlocksForMedian);
      if (!medianValidation.valid) {
        return { valid: false, error: `Block ${block.index}: ${medianValidation.error}` };
      }
      
      // validate difficulty
      const expectedDifficulty = await this.getDifficulty(block.index);
      const difficultyValidation = blockClass.validateDifficulty(expectedDifficulty);
      if (!difficultyValidation.valid) {
        return { valid: false, error: `Block ${block.index}: ${difficultyValidation.error}` };
      }
      
      // validate coinbase
      const blockReward = this.getBlockReward(block.index);
      const coinbaseValidation = blockClass.validateCoinbase(blockReward);
      if (!coinbaseValidation.valid) {
        return { valid: false, error: `Block ${block.index}: ${coinbaseValidation.error}` };
      }
    }
    
    return { valid: true };
  }
  
  /**
   * get past blocks for median time validation during reorganization
   */
  private getPastBlocksForReorg(
    ancestorBlocks: BlockClass[],
    newBlocksBefore: Block[],
    count: number
  ): BlockClass[] {
    const allBlocks: BlockClass[] = [...ancestorBlocks];
    
    // add new blocks that come before current block
    for (const block of newBlocksBefore) {
      const blockClass = block instanceof BlockClass ? block : BlockClass.fromObject(block);
      allBlocks.push(blockClass);
    }
    
    // return last 'count' blocks
    return allBlocks.slice(-count);
  }
  
  /**
   * add block during reorganization with special handling for median time
   */
  private async addBlockDuringReorg(
    block: BlockClass,
    previousNewBlocks: Block[]
  ): Promise<ValidationResult> {
    if (!this.isInitialized) {
      throw new Error('Blockchain not initialized');
    }
    
    logger.debug(`Adding block ${block.index} during reorganization`);
    
    // validate block structure
    const structureValidation = block.validate(this.hashAlgorithm);
    if (!structureValidation.valid) {
      return structureValidation;
    }
    
    // get previous block
    const previousBlock = await this.storage.getBlock(block.index - 1);
    if (!previousBlock) {
      return { valid: false, error: 'Previous block not found' };
    }
    
    const prevBlockClass = BlockClass.fromObject(previousBlock);
    
    // validate against previous block
    const prevValidation = block.validatePreviousBlock(prevBlockClass);
    if (!prevValidation.valid) {
      return prevValidation;
    }
    
    // for median time validation, we need to consider the new chain being built
    // get past blocks including those from the new chain
    const pastBlocks = await this.getPastBlocksForReorgAdd(previousNewBlocks, 11);
    const medianValidation = block.validateMedianTime(pastBlocks);
    if (!medianValidation.valid) {
      return medianValidation;
    }
    
    // validate difficulty
    const expectedDifficulty = await this.getDifficulty(block.index);
    const difficultyValidation = block.validateDifficulty(expectedDifficulty);
    if (!difficultyValidation.valid) {
      return difficultyValidation;
    }
    
    // validate coinbase
    const blockReward = this.getBlockReward(block.index);
    const coinbaseValidation = block.validateCoinbase(blockReward);
    if (!coinbaseValidation.valid) {
      return coinbaseValidation;
    }
    
    // validate all transactions
    const txValidation = await this.validateBlockTransactions(block);
    if (!txValidation.valid) {
      return txValidation;
    }
    
    // process transactions and update state
    await this.processBlockTransactions(block);
    
    // save block to storage
    await this.storage.saveBlock(block.toObject());
    
    // update cumulative difficulty
    const currentCumulative = await this.storage.getCumulativeDifficulty();
    const newCumulative = currentCumulative + BigInt(block.difficulty);
    await this.storage.updateCumulativeDifficulty(newCumulative);
    
    // update current height
    this.currentHeight = block.index;
    
    logger.info(`Block ${block.index} added successfully during reorganization`);
    
    // emit event with block details for metrics recording
    this.emit('blockAdded', block);
    
    return { valid: true };
  }
  
  /**
   * get past blocks during reorganization add phase
   */
  private async getPastBlocksForReorgAdd(
    previousNewBlocks: Block[],
    count: number
  ): Promise<BlockClass[]> {
    const blocks: BlockClass[] = [];
    const startHeight = Math.max(0, this.currentHeight - count + 1);
    
    // first get blocks from storage up to current height
    for (let height = startHeight; height <= this.currentHeight; height++) {
      const block = await this.storage.getBlock(height);
      if (block) {
        blocks.push(BlockClass.fromObject(block));
      }
    }
    
    // then add any new blocks that were already added during this reorg
    for (const block of previousNewBlocks) {
      if (block.index > this.currentHeight) {
        const blockClass = block instanceof BlockClass ? block : BlockClass.fromObject(block);
        blocks.push(blockClass);
      }
    }
    
    // return last 'count' blocks
    return blocks.slice(-count);
  }
  
  /**
   * recalculate account states from a specific height
   */
  private async recalculateStateFromHeight(startHeight: number, endHeight: number): Promise<void> {
    logger.info(`Recalculating state from height ${startHeight} to ${endHeight}`);
    
    // reset all account states
    const accounts = new Map<string, AccountState>();
    
    // process all blocks up to end height
    for (let height = startHeight; height <= endHeight; height++) {
      const block = await this.storage.getBlock(height);
      if (!block) continue;
      
      // process each transaction
      for (const tx of block.transactions) {
        // handle coinbase
        if (tx.from === null) {
          const recipientState = accounts.get(tx.to) || { balance: 0n, nonce: 0 };
          recipientState.balance += tx.amount;
          accounts.set(tx.to, recipientState);
        } else {
          // handle regular transaction
          const senderState = accounts.get(tx.from) || { balance: 0n, nonce: 0 };
          const recipientState = accounts.get(tx.to) || { balance: 0n, nonce: 0 };
          
          senderState.balance -= (tx.amount + tx.fee);
          senderState.nonce = tx.nonce + 1;
          recipientState.balance += tx.amount;
          
          accounts.set(tx.from, senderState);
          accounts.set(tx.to, recipientState);
        }
      }
    }
    
    // update storage with recalculated states
    for (const [address, state] of accounts) {
      await this.storage.updateAccountState(address, state);
    }
  }

  /**
   * get past blocks for median time validation
   */
  private async getPastBlocks(count: number): Promise<BlockClass[]> {
    const blocks: BlockClass[] = [];
    const startHeight = Math.max(0, this.currentHeight - count + 1);

    for (let height = startHeight; height <= this.currentHeight; height++) {
      const block = await this.storage.getBlock(height);
      if (block) {
        blocks.push(BlockClass.fromObject(block));
      }
    }

    return blocks;
  }

  /**
   * create block template for mining
   */
  async createBlockTemplate(
    transactions: Transaction[],
    minerAddress: string
  ): Promise<BlockTemplate> {
    if (!this.isInitialized) {
      throw new Error('Blockchain not initialized');
    }

    const height = this.currentHeight + 1;
    const previousBlock = await this.storage.getLatestBlock();

    if (!previousBlock) {
      throw new Error('No previous block found');
    }

    // calculate fees
    const totalFees = transactions.reduce((sum, tx) => sum + tx.fee, 0n);

    // get block reward
    const blockReward = this.getBlockReward(height);

    // create coinbase transaction
    const coinbase = createCoinbaseTransaction(
      minerAddress,
      blockReward,
      totalFees,
      Date.now()
    );

    // get difficulty
    const difficulty = await this.getDifficulty(height);

    return {
      previousHash: previousBlock.hash,
      height,
      transactions: [coinbase.toObject(), ...transactions],
      difficulty,
      coinbaseValue: blockReward + totalFees,
      timestamp: Date.now()
    };
  }

  /**
   * get chain configuration
   */
  getConfig(): ChainConfig {
    return this.config;
  }

  /**
   * check if blockchain is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }
  
  /**
   * get chain configuration
   */
  getChainConfig(): ChainConfig {
    return this.config;
  }
  
  /**
   * calculate block reward for a given height (public version)
   */
  calculateBlockReward(blockHeight: number): bigint {
    return this.getBlockReward(blockHeight);
  }

  /**
   * cleanup and close storage connection
   */
  async close(): Promise<void> {
    if (this.storage.isConnected) {
      await this.storage.close();
    }
    this.isInitialized = false;
  }
}
