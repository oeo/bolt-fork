import { EventEmitter } from 'events';
import { Block, Transaction, AccountState, BlockTemplate, ValidationResult } from '../types';
import { PersistedMempoolEntry, StaleChainTipError, StorageAdapter } from '../storage/adapter';
import { ChainConfig } from '../config/chain';
import {
  BlockClass,
  createGenesisBlock,
  validateBlockHeader,
  validateBlockHeaderMedianTime,
  validateBlockHeaderPrevious,
  type BlockHeader,
} from './block';
import { TransactionClass, createCoinbaseTransaction } from './transaction';
import { getDifficultyAdjustment, shouldAdjustDifficulty, DifficultyConfig, calculateBlockWork, calculateCumulativeDifficulty } from './difficulty';
import { HashAlgorithm, hash } from '../crypto/hash';
import { ForkManager } from './fork-manager';
import { getLogger } from '../utils/logger';
import { calculateStateRoot, executeBlock, type BlockExecution } from './block-executor';
import {
  DEFAULT_MEMPOOL_LIMITS,
  selectMempoolLimitRemovals,
  type MempoolEntry,
} from './mempool';

const logger = getLogger(__filename);
const STORAGE_VERSION = '8';
const MEMPOOL_TRANSACTION_FUTURE_TIME_MS = 15 * 60 * 1000;

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
  private chainWriteTail: Promise<void> = Promise.resolve();

  constructor(
    storage: StorageAdapter,
    config: ChainConfig,
    hashAlgorithm: HashAlgorithm = 'sha256'
  ) {
    super();
    if (config.hashAlgorithm !== 'sha256' || hashAlgorithm !== 'sha256') {
      throw new Error('bolt consensus requires sha256');
    }
    this.storage = storage;
    this.config = config;
    this.hashAlgorithm = hashAlgorithm;
    this.forkManager = new ForkManager();

    // setup difficulty config from chain config
    this.difficultyConfig = {
      adjustmentInterval: config.difficultyAdjustmentInterval,
      targetBlockTime: config.targetBlockTime,
      maxAdjustmentFactor: config.maxDifficultyAdjustment,
      minDifficulty: config.minDifficulty
    };
  }

  /**
   * initialize blockchain (create genesis if needed)
   */
  async initialize(): Promise<void> {
    return this.withChainWrite(() => this.initializeUnlocked());
  }

  private async initializeUnlocked(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Blockchain already initialized');
      return;
    }

    logger.info(`Initializing blockchain for network: ${this.config.name}`);

    const configuredGenesis = this.getConfiguredGenesis();

    await this.storage.connect();

    // check for existing blockchain
    const latestBlock = await this.storage.getLatestBlock();
    const storedVersion = (await this.storage.getChainMetadata('storageVersion'))?.toString();
    const storedChainId = (await this.storage.getChainMetadata('chainId'))?.toString();
    const storedChainSpec = (await this.storage.getChainMetadata('chainSpec'))?.toString();

    if (latestBlock) {
      const storedGenesis = await this.storage.getBlock(0);
      if (!storedGenesis || !this.matchesConfiguredGenesis(storedGenesis, configuredGenesis.toObject())) {
        throw new Error('Stored genesis does not match configured genesis');
      }
    }

    if (latestBlock && (storedVersion !== STORAGE_VERSION ||
        storedChainId !== this.config.chainId.toString() || storedChainSpec !== this.chainSpec())) {
      throw new Error('Stored chain is incompatible with current storage version or chain ID');
    }

    if (!latestBlock) {
      await this.storage.saveChainMetadata('storageVersion', STORAGE_VERSION);
      await this.storage.saveChainMetadata('chainId', this.config.chainId.toString());
      await this.storage.saveChainMetadata('chainSpec', this.chainSpec());
    }

    if (latestBlock) {

      this.currentHeight = latestBlock.index;
      const integrity = await this.verifyChainIntegrity();
      if (!integrity.valid) throw new Error(`Stored chain integrity check failed: ${integrity.error}`);
      logger.info(`Blockchain loaded at height ${this.currentHeight}`);
    } else {
      // create genesis block
      await this.createGenesis(configuredGenesis);
    }

    this.isInitialized = true;
  }

  private chainSpec(): string {
    return JSON.stringify(this.config, (_, value) => typeof value === 'bigint' ? value.toString() : value);
  }

  /**
   * create and save genesis block
   */
  private async createGenesis(genesis: BlockClass): Promise<void> {
    logger.info('Creating genesis block');

    await this.storage.withStateWrite(() => this.storage.transitionCanonicalChain({
      expectedTip: { height: -1, hash: null },
      expectedCumulativeDifficulty: 0n,
      ancestor: { height: -1, hash: null },
      blocks: [genesis.toObject()],
      accountStates: [],
      cumulativeDifficulty: calculateBlockWork(genesis.difficulty),
      mempoolAdditions: [],
      mempoolRemovals: [],
    }));

    this.currentHeight = 0;

    logger.info(`Genesis block created: ${genesis.hash}`);
  }

  private getConfiguredGenesis(): BlockClass {
    if (!Number.isSafeInteger(this.config.genesisTimestamp) || this.config.genesisTimestamp < 0) {
      throw new Error('Invalid configured genesis timestamp');
    }
    if (!Number.isSafeInteger(this.config.genesisNonce) || this.config.genesisNonce < 0) {
      throw new Error('Invalid configured genesis nonce');
    }

    const genesis = createGenesisBlock(
      this.config.initialDifficulty,
      this.config.genesisTimestamp,
      calculateStateRoot(new Map()),
      this.config.genesisNonce
    );
    const validation = genesis.validate(this.hashAlgorithm, Number.MAX_SAFE_INTEGER);
    if (!validation.valid) throw new Error(`Invalid configured genesis: ${validation.error}`);
    return genesis;
  }

  private matchesConfiguredGenesis(stored: Block, configured: Block): boolean {
    return stored.index === configured.index &&
      stored.timestamp === configured.timestamp &&
      stored.previousHash === configured.previousHash &&
      stored.hash === configured.hash &&
      stored.merkleRoot === configured.merkleRoot &&
      stored.stateRoot === configured.stateRoot &&
      stored.difficulty === configured.difficulty &&
      stored.nonce === configured.nonce &&
      stored.transactions.length === 0 &&
      stored.miner === undefined;
  }

  /**
   * add a new block to the blockchain
   */
  async addBlock(block: BlockClass): Promise<ValidationResult> {
    return this.withChainWrite(() => this.addBlockUnlocked(block));
  }

  private async addBlockUnlocked(block: BlockClass): Promise<ValidationResult> {
    if (!this.isInitialized) {
      throw new Error('Blockchain not initialized');
    }

    logger.debug(`Adding block ${block.index} to blockchain`);

    // validate block structure
    const structureValidation = block.validate(this.hashAlgorithm, this.config.maxTimeDrift * 1000);
    if (!structureValidation.valid) {
      return structureValidation;
    }

    const sizeValidation = block.validateSize(this.config.maxBlockSize);
    if (!sizeValidation.valid) {
      return sizeValidation;
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
      return await this.handleCompetingBlockUnlocked(block);
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
    const pastBlocks = await this.getPastBlocks(this.config.medianTimeBlocks);
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

    for (const transaction of block.transactions) {
      if (await this.storage.getTransaction(transaction.hash)) {
        return { valid: false, error: `Duplicate confirmed transaction: ${transaction.hash}` };
      }
    }

    let execution: BlockExecution;
    try {
      execution = await this.executeBlock(block);
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (block.stateRoot !== execution.stateRoot) {
      return { valid: false, error: 'Invalid state root' };
    }

    // update cumulative difficulty
    const currentCumulative = await this.storage.getCumulativeDifficulty();
    const newCumulative = currentCumulative + calculateBlockWork(block.difficulty);
    try {
      await this.storage.withStateWrite(async () => {
        const confirmed = block.transactions.filter(tx => tx.from !== null).map(tx => tx.hash);
        const mempoolRemovals = await this.prepareExtensionMempoolRemovals(execution.accountStates, confirmed);
        await this.storage.transitionCanonicalChain({
          expectedTip: { height: previousBlock.index, hash: previousBlock.hash },
          expectedCumulativeDifficulty: currentCumulative,
          ancestor: { height: previousBlock.index, hash: previousBlock.hash },
          blocks: [block.toObject()],
          accountStates: Array.from(execution.accountStates, ([address, state]) => ({ address, state })),
          cumulativeDifficulty: newCumulative,
          mempoolAdditions: [],
          mempoolRemovals,
        });
      });
    } catch (error) {
      if (error instanceof StaleChainTipError) {
        this.currentHeight = error.actualTip.height;
        return { valid: false, error: error.message };
      }
      throw error;
    }

    // update current height
    this.currentHeight = block.index;

    logger.info(`Block ${block.index} added successfully`);

    // emit event with block details for metrics recording
    this.emitCommitted('block:added', block);

    return { valid: true };
  }

  async prepareBlock(
    block: BlockClass,
    currentStates?: ReadonlyMap<string, AccountState>
  ): Promise<Map<string, AccountState>> {
    const execution = currentStates
      ? await executeBlock(block.toObject(), currentStates, this.config, this.getBlockReward(block.index))
      : await this.executeBlock(block);
    block.stateRoot = execution.stateRoot;
    return execution.accountStates;
  }

  private async executeBlock(block: BlockClass): Promise<BlockExecution> {
    const accountStates = new Map<string, AccountState>();
    for (const address of await this.storage.getAllAccountAddresses()) {
      const state = await this.storage.getAccountState(address);
      if (state) accountStates.set(address, state);
    }
    return executeBlock(block.toObject(), accountStates, this.config, this.getBlockReward(block.index));
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
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
      throw new Error(`Invalid block height: ${blockHeight}`);
    }
    if (blockHeight === 0) return 0n;

    const halvings = Math.floor(blockHeight / this.config.halvingInterval);
    const reward = this.config.initialReward >> BigInt(halvings);
    const remaining = this.config.maxSupply - this.calculateIssuedSupply(blockHeight);
    if (remaining <= 0n) return 0n;
    return reward < remaining ? reward : remaining;
  }

  /**
   * calculate total supply up to a given height
   */
  private calculateIssuedSupply(blockHeight: number): bigint {
    let remainingBlocks = blockHeight - 1;
    let era = 0;
    let eraBlocks = this.config.halvingInterval - 1;
    let issued = 0n;

    while (remainingBlocks > 0) {
      const reward = this.config.initialReward >> BigInt(era);
      if (reward === 0n) break;
      const blocks = Math.min(remainingBlocks, eraBlocks);
      issued += BigInt(blocks) * reward;
      if (issued >= this.config.maxSupply) return this.config.maxSupply;
      remainingBlocks -= blocks;
      era++;
      eraBlocks = this.config.halvingInterval;
    }

    return issued;
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

  async validateHeaderChain(headers: BlockHeader[], maxReorgDepth = Number.MAX_SAFE_INTEGER): Promise<{
    valid: boolean;
    error?: string;
    ancestor?: Block;
    cumulativeDifficulty?: bigint;
  }> {
    if (headers.length === 0) return { valid: false, error: 'Empty header chain' };
    const ancestor = await this.storage.getBlockByHash(headers[0].previousHash);
    if (!ancestor || (await this.storage.getBlock(ancestor.index))?.hash !== ancestor.hash) {
      return { valid: false, error: 'Header chain has no canonical ancestor' };
    }
    const currentHeight = await this.getHeight();
    if (currentHeight - ancestor.index > maxReorgDepth) {
      return { valid: false, error: 'Header chain exceeds reorganization depth' };
    }

    const candidate = new Map<number, BlockHeader>();
    const getHeader = async (height: number): Promise<BlockHeader | null> =>
      candidate.get(height) ?? (height <= ancestor.index ? this.storage.getBlock(height) : null);
    let cumulativeDifficulty = await this.storage.getCumulativeDifficulty();
    for (let height = ancestor.index + 1; height <= currentHeight; height++) {
      const block = await this.storage.getBlock(height);
      if (!block) return { valid: false, error: `Missing canonical block ${height}` };
      cumulativeDifficulty -= calculateBlockWork(block.difficulty);
    }

    let previous: BlockHeader = ancestor;
    for (const header of headers) {
      const structure = validateBlockHeader(
        header,
        this.config.maxTimeDrift * 1000,
        this.hashAlgorithm
      );
      if (!structure.valid) return structure;
      const linkage = validateBlockHeaderPrevious(header, previous);
      if (!linkage.valid) return linkage;

      const pastHeaders: BlockHeader[] = [];
      for (let height = Math.max(0, header.index - this.config.medianTimeBlocks); height < header.index; height++) {
        const past = await getHeader(height);
        if (past) pastHeaders.push(past);
      }
      const median = validateBlockHeaderMedianTime(header, pastHeaders);
      if (!median.valid) return median;
      const expectedDifficulty = await getDifficultyAdjustment(
        header.index,
        getHeader,
        this.difficultyConfig
      );
      if (header.difficulty !== expectedDifficulty) {
        return {
          valid: false,
          error: `Invalid difficulty: expected ${expectedDifficulty}, got ${header.difficulty}`
        };
      }

      candidate.set(header.index, header);
      cumulativeDifficulty += calculateBlockWork(header.difficulty);
      previous = header;
    }
    return { valid: true, ancestor, cumulativeDifficulty };
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

  async hasBlock(hash: string): Promise<boolean> {
    return (await this.storage.getBlockByHash(hash)) !== null;
  }

  async hasTransaction(hash: string): Promise<boolean> {
    return (await this.storage.getTransaction(hash)) !== null;
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
    let accountStates = new Map<string, AccountState>();
    let expectedHeight = 0;
    const configuredGenesis = this.getConfiguredGenesis().toObject();

    for await (const block of this.iterateChain()) {
      if (block.index !== expectedHeight++) {
        return { valid: false, error: `Missing canonical block ${expectedHeight - 1}` };
      }
      if (block.index === 0 && !this.matchesConfiguredGenesis(block, configuredGenesis)) {
        return { valid: false, error: 'Stored genesis does not match configured genesis' };
      }
      const blockClass = BlockClass.fromObject(block);

      // validate block structure
      const validation = blockClass.validate(this.hashAlgorithm, this.config.maxTimeDrift * 1000);
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

      if (block.index === 0) {
        if (block.stateRoot !== calculateStateRoot(accountStates)) {
          return { valid: false, error: 'Block 0: Invalid state root' };
        }
      } else {
        try {
          const execution = await executeBlock(
            block,
            accountStates,
            this.config,
            this.getBlockReward(block.index)
          );
          if (block.stateRoot !== execution.stateRoot) {
            return { valid: false, error: `Block ${block.index}: Invalid state root` };
          }
          accountStates = execution.accountStates;
        } catch (error) {
          return { valid: false, error: `Block ${block.index}: ${error instanceof Error ? error.message : String(error)}` };
        }
      }

      // accumulate difficulty
      cumulativeDifficulty += calculateBlockWork(block.difficulty);

      previousBlock = block;

      for (let transactionIndex = 0; transactionIndex < block.transactions.length; transactionIndex++) {
        const transaction = block.transactions[transactionIndex];
        const confirmed = await this.storage.getConfirmedTransaction(transaction.hash);
        if (!confirmed || confirmed.blockHash !== block.hash || confirmed.blockHeight !== block.index ||
            confirmed.transactionIndex !== transactionIndex || confirmed.canonicalHeight !== this.currentHeight) {
          return { valid: false, error: `Invalid confirmed transaction index: ${transaction.hash}` };
        }
      }
    }

    if (expectedHeight !== this.currentHeight + 1) {
      return { valid: false, error: `Canonical height mismatch: stored=${this.currentHeight}, verified=${expectedHeight - 1}` };
    }

    // verify cumulative difficulty matches
    const storedCumulative = await this.storage.getCumulativeDifficulty();
    if (storedCumulative !== cumulativeDifficulty) {
      return {
        valid: false,
        error: `Cumulative difficulty mismatch: stored=${storedCumulative}, calculated=${cumulativeDifficulty}`
      };
    }

    const storedAddresses = await this.storage.getAllAccountAddresses();
    if (storedAddresses.length !== accountStates.size) {
      return { valid: false, error: 'Stored account index does not match canonical state' };
    }
    for (const [address, state] of accountStates) {
      const stored = await this.storage.getAccountState(address);
      if (!stored || stored.balance !== state.balance || stored.nonce !== state.nonce) {
        return { valid: false, error: `Stored account state mismatch: ${address}` };
      }
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
    return this.withChainWrite(() => this.handleCompetingBlockUnlocked(block, peerId));
  }

  private async handleCompetingBlockUnlocked(block: BlockClass, peerId?: string): Promise<ValidationResult> {
    logger.info(`Handling competing block ${block.index} with hash ${block.hash}`);

    const structureValidation = block.validate(this.hashAlgorithm, this.config.maxTimeDrift * 1000);
    if (!structureValidation.valid) return structureValidation;
    const sizeValidation = block.validateSize(this.config.maxBlockSize);
    if (!sizeValidation.valid) return sizeValidation;
    
    // check if this block extends a known fork
    const fork = this.forkManager.updateFork(block.previousHash, block.toObject(), peerId);
    
    if (!fork) {
      // new fork or orphan block
      const previousBlock = await this.storage.getBlockByHash(block.previousHash);
      if (previousBlock) {
        // new fork starting from our chain
        const forkBase = await this.storage.getBlock(previousBlock.index);
        if (forkBase) {
          let forkCumulativeDifficulty = calculateBlockWork(block.difficulty);
          for (let height = 0; height <= forkBase.index; height++) {
            const canonicalBlock = await this.storage.getBlock(height);
            if (!canonicalBlock) return { valid: false, error: `Missing canonical block ${height}` };
            forkCumulativeDifficulty += calculateBlockWork(canonicalBlock.difficulty);
          }
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
        let success = false;
        if (commonAncestorHeight >= 0) {
          success = await this.reorganizeUnlocked(commonAncestorHeight, bestFork.blocks);
        }
        this.forkManager.removeFork(bestFork.tipHash);
        if (success) return { valid: true };
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
    return this.withChainWrite(() => this.reorganizeUnlocked(commonAncestorHeight, newBlocks));
  }

  private async reorganizeUnlocked(commonAncestorHeight: number, newBlocks: Block[]): Promise<boolean> {
    logger.warn(`Starting chain reorganization from height ${commonAncestorHeight}`);
    if (newBlocks.length === 0) return false;

    const expectedTip = await this.storage.getLatestBlock();
    const ancestor = await this.storage.getBlock(commonAncestorHeight);
    if (!expectedTip || !ancestor || commonAncestorHeight >= expectedTip.index) return false;

    const expectedCumulativeDifficulty = await this.storage.getCumulativeDifficulty();
    let candidateCumulativeDifficulty = 0n;
    const candidateTransactionHashes = new Set<string>();
    for (let height = 0; height <= commonAncestorHeight; height++) {
      const block = await this.storage.getBlock(height);
      if (!block) return false;
      for (const transaction of block.transactions) candidateTransactionHashes.add(transaction.hash);
      candidateCumulativeDifficulty += calculateBlockWork(block.difficulty);
    }

    const candidateBlocks = new Map<number, Block>();
    const getCandidateBlock = async (height: number): Promise<Block | null> => {
      const candidate = candidateBlocks.get(height);
      if (candidate) return candidate;
      return height <= commonAncestorHeight ? this.storage.getBlock(height) : null;
    };
    let accountStates = await this.recalculateStateFromHeight(0, commonAncestorHeight);

    for (let i = 0; i < newBlocks.length; i++) {
      const block = newBlocks[i];
      const blockClass = BlockClass.fromObject(block);
      const structureValidation = blockClass.validate(this.hashAlgorithm, this.config.maxTimeDrift * 1000);
      if (!structureValidation.valid) return false;
      const sizeValidation = blockClass.validateSize(this.config.maxBlockSize);
      if (!sizeValidation.valid) return false;
      for (const transaction of block.transactions) {
        if (candidateTransactionHashes.has(transaction.hash)) return false;
        candidateTransactionHashes.add(transaction.hash);
      }

      const previousBlock = i === 0 ? ancestor : newBlocks[i - 1];
      if (!blockClass.validatePreviousBlock(BlockClass.fromObject(previousBlock)).valid) return false;

      const pastBlocks: BlockClass[] = [];
      for (let height = Math.max(0, block.index - this.config.medianTimeBlocks); height < block.index; height++) {
        const pastBlock = await getCandidateBlock(height);
        if (pastBlock) pastBlocks.push(BlockClass.fromObject(pastBlock));
      }
      if (!blockClass.validateMedianTime(pastBlocks).valid) return false;

      const expectedDifficulty = await getDifficultyAdjustment(
        block.index,
        getCandidateBlock,
        this.difficultyConfig
      );
      if (!blockClass.validateDifficulty(expectedDifficulty).valid) return false;

      try {
        const execution = await executeBlock(
          block,
          accountStates,
          this.config,
          this.getBlockReward(block.index)
        );
        if (block.stateRoot !== execution.stateRoot) return false;
        accountStates = execution.accountStates;
      } catch {
        return false;
      }

      candidateBlocks.set(block.index, block);
      candidateCumulativeDifficulty += calculateBlockWork(block.difficulty);
    }

    if (candidateCumulativeDifficulty <= expectedCumulativeDifficulty) return false;

    const removedBlocks: Block[] = [];
    for (let height = commonAncestorHeight + 1; height <= expectedTip.index; height++) {
      const block = await this.storage.getBlock(height);
      if (block) removedBlocks.push(block);
    }

    try {
      await this.storage.withStateWrite(async () => {
        const mempoolUpdate = await this.prepareReorgMempoolUpdate(removedBlocks, newBlocks, accountStates);
        await this.storage.transitionCanonicalChain({
          expectedTip: { height: expectedTip.index, hash: expectedTip.hash },
          expectedCumulativeDifficulty,
          ancestor: { height: ancestor.index, hash: ancestor.hash },
          blocks: newBlocks,
          accountStates: Array.from(accountStates, ([address, state]) => ({ address, state })),
          cumulativeDifficulty: candidateCumulativeDifficulty,
          mempoolAdditions: mempoolUpdate.additions,
          mempoolRemovals: mempoolUpdate.removals,
        });
      });
    } catch (error) {
      if (error instanceof StaleChainTipError) {
        this.currentHeight = error.actualTip.height;
        return false;
      }
      throw error;
    }

    this.currentHeight = newBlocks.at(-1)!.index;
    this.emitCommitted('chain:reorganized', {
      ancestor,
      removedBlocks,
      addedBlocks: newBlocks,
    });
    for (const block of newBlocks) this.emitCommitted('block:added', BlockClass.fromObject(block));
    logger.info(`Chain reorganization completed, new height=${this.currentHeight}`);
    return true;
  }

  private async prepareExtensionMempoolRemovals(
    accountStates: ReadonlyMap<string, AccountState>,
    confirmedHashes: string[]
  ): Promise<string[]> {
    const removals = new Set(confirmedHashes);
    const bySender = new Map<string, PersistedMempoolEntry[]>();
    for (const entry of await this.storage.getMempoolEntries()) {
      const sender = entry.transaction.from;
      if (!sender || removals.has(entry.transaction.hash)) continue;
      const queue = bySender.get(sender) ?? [];
      queue.push(entry);
      bySender.set(sender, queue);
    }
    for (const [sender, queue] of bySender) {
      queue.sort((a, b) =>
        a.transaction.nonce - b.transaction.nonce ||
        a.addedAt - b.addedAt ||
        a.transaction.hash.localeCompare(b.transaction.hash)
      );
      let { balance, nonce } = accountStates.get(sender) ?? { balance: 0n, nonce: 0 };
      for (const entry of queue) {
        const transaction = TransactionClass.fromObject(entry.transaction);
        const validation = transaction.validateAgainstAccount(balance, nonce);
        if (!validation.valid) {
          removals.add(transaction.hash);
          continue;
        }
        balance -= transaction.amount + transaction.fee;
        nonce++;
      }
    }
    return [...removals];
  }

  private async prepareReorgMempoolUpdate(
    removedBlocks: Block[],
    addedBlocks: Block[],
    accountStates: ReadonlyMap<string, AccountState>
  ): Promise<{ additions: PersistedMempoolEntry[]; removals: string[] }> {
    const policy = this.storage.getMempoolPolicy() ?? {
      ...DEFAULT_MEMPOOL_LIMITS,
      minFeePerByte: this.config.minFeePerByte,
    };
    const confirmed = new Set(addedBlocks.flatMap(block => block.transactions.map(tx => tx.hash)));
    const persisted = await this.storage.getMempoolEntries();
    const persistedHashes = new Set(persisted.map(entry => entry.transaction.hash));
    const candidates = persisted.filter(entry => !confirmed.has(entry.transaction.hash));
    let addedAt = Date.now();
    for (const transaction of removedBlocks.flatMap(block => block.transactions)) {
      if (transaction.from === null || confirmed.has(transaction.hash) || persistedHashes.has(transaction.hash)) continue;
      candidates.push({ transaction, addedAt: addedAt++ });
    }

    const bySender = new Map<string, PersistedMempoolEntry[]>();
    for (const entry of candidates) {
      const sender = entry.transaction.from;
      if (!sender) continue;
      const queue = bySender.get(sender) ?? [];
      queue.push(entry);
      bySender.set(sender, queue);
    }

    const additions: PersistedMempoolEntry[] = [];
    const validEntries: MempoolEntry[] = [];
    const removals = new Set(confirmed);
    for (const [sender, queue] of [...bySender].sort(([a], [b]) => a.localeCompare(b))) {
      queue.sort((a, b) =>
        a.transaction.nonce - b.transaction.nonce ||
        a.addedAt - b.addedAt ||
        a.transaction.hash.localeCompare(b.transaction.hash)
      );
      let { balance, nonce } = accountStates.get(sender) ?? { balance: 0n, nonce: 0 };
      for (const entry of queue) {
        const transaction = TransactionClass.fromObject(entry.transaction);
        const structure = transaction.validate(
          this.config.chainId,
          this.config.addressPrefix,
          Date.now() + MEMPOOL_TRANSACTION_FUTURE_TIME_MS
        );
        const account = transaction.validateAgainstAccount(balance, nonce);
        const size = transaction.getSize();
        const policyValid =
          size <= policy.maxTransactionSize &&
          transaction.fee / BigInt(size) >= policy.minFeePerByte;
        const valid = structure.valid && account.valid && policyValid && await transaction.verify();
        if (!valid) {
          if (persistedHashes.has(transaction.hash)) removals.add(transaction.hash);
          continue;
        }
        balance -= transaction.amount + transaction.fee;
        nonce++;
        validEntries.push({
          transaction: entry.transaction,
          addedAt: entry.addedAt,
          size,
          feePerByte: transaction.fee / BigInt(size),
        });
        if (!persistedHashes.has(transaction.hash)) additions.push(entry);
      }
    }
    for (const hash of selectMempoolLimitRemovals(
      validEntries,
      policy.maxSize,
      policy.maxSizeBytes
    )) removals.add(hash);
    return {
      additions: additions.filter(entry => !removals.has(entry.transaction.hash)),
      removals: [...removals],
    };
  }
  
  /**
   * recalculate account states from a specific height
   */
  private async recalculateStateFromHeight(
    startHeight: number,
    endHeight: number
  ): Promise<Map<string, AccountState>> {
    logger.info(`Recalculating state from height ${startHeight} to ${endHeight}`);
    
    let accounts = new Map<string, AccountState>();
    
    // process all blocks up to end height
    for (let height = startHeight; height <= endHeight; height++) {
      const block = await this.storage.getBlock(height);
      if (!block) continue;
      
      if (height === 0) {
        if (block.stateRoot !== calculateStateRoot(accounts)) throw new Error('Invalid genesis state root');
        continue;
      }

      const execution = await executeBlock(block, accounts, this.config, this.getBlockReward(height));
      if (block.stateRoot !== execution.stateRoot) throw new Error(`Invalid state root at height ${height}`);
      accounts = execution.accountStates;
    }
    
    return accounts;
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
  ): Promise<{
    previousHash: string;
    height: number;
    transactions: Transaction[];
    difficulty: number;
    coinbaseValue: bigint;
    timestamp: number;
  }> {
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
    const timestamp = Math.max(Date.now(), previousBlock.timestamp + 1);

    // create coinbase transaction
    const coinbase = createCoinbaseTransaction(
      this.config.chainId,
      minerAddress,
      blockReward,
      totalFees,
      timestamp
    );

    // get difficulty
    const difficulty = await this.getDifficulty(height);

    return {
      previousHash: previousBlock.hash,
      height,
      transactions: [coinbase.toObject(), ...transactions],
      difficulty,
      coinbaseValue: blockReward + totalFees,
      timestamp
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

  private async withChainWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.chainWriteTail;
    let release!: () => void;
    this.chainWriteTail = new Promise(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private emitCommitted(event: string, value: unknown): void {
    try {
      this.emit(event, value);
    } catch (error) {
      logger.error(`Committed ${event} listener failed`, error);
    }
  }

  /**
   * cleanup and close storage connection
   */
  async close(): Promise<void> {
    await this.withChainWrite(async () => {
      await this.storage.close();
      this.isInitialized = false;
    });
  }
}
