import type { Blockchain } from '../core/blockchain';
import type { Mempool } from '../core/mempool';
import { BlockClass } from '../core/block';
import { difficultyToTarget } from '../crypto/hash';
import type { BlockTemplate, BlockTemplateRequest, BlockSubmission } from '../types';
import { buildBlockCandidate } from './block-candidate';

const TEMPLATE_EXPIRY_MS = 30_000;
const LONGPOLL_TIMEOUT_MS = 60_000;
const MAX_JOBS = 10;
const MAX_LONGPOLLS = 32;
const ID_PATTERN = /^[0-9a-f-]{36}$/;

interface Subscription {
  payoutAddress: string;
  resolve: (template: BlockTemplate) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GetBlockTemplateService {
  private jobs = new Map<string, BlockTemplate>();
  private currentByPayout = new Map<string, string>();
  private seenLongpoll = new Map<string, string>();
  private subscriptions = new Map<string, Subscription>();
  private readonly blockHandler = (): void => { void this.refreshSubscriptions(); };
  private readonly transactionHandler = (): void => { void this.refreshSubscriptions(); };

  constructor(private blockchain: Blockchain, private mempool: Mempool) {
    blockchain.on('block:added', this.blockHandler);
    mempool.on('transactionAdded', this.transactionHandler);
  }

  async getBlockTemplate(request: BlockTemplateRequest): Promise<BlockTemplate> {
    let template = this.getCurrent(request.payoutAddress);
    const tip = await this.blockchain.getLatestBlock();
    if (!template || !tip || template.expiresAt <= Date.now() ||
        template.height !== tip.index + 1 || template.previousHash !== tip.hash) {
      template = await this.generate(request.payoutAddress);
    }

    if (!request.longpollId) return template;
    if (request.longpollId.length > 64) throw new Error('Invalid longpoll ID');
    const seen = this.seenLongpoll.get(request.longpollId);
    this.seenLongpoll.set(request.longpollId, template.templateId);
    while (this.seenLongpoll.size > MAX_LONGPOLLS) this.seenLongpoll.delete(this.seenLongpoll.keys().next().value!);
    if (seen !== template.templateId) return template;
    if (!this.subscriptions.has(request.longpollId) && this.subscriptions.size >= MAX_LONGPOLLS) {
      throw new Error('Longpoll subscription limit reached');
    }

    return new Promise(resolve => {
      const existing = this.subscriptions.get(request.longpollId!);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve(template!);
      }
      const timer = setTimeout(() => {
        this.subscriptions.delete(request.longpollId!);
        void this.generate(request.payoutAddress).then(resolve, () => resolve(template!));
      }, LONGPOLL_TIMEOUT_MS);
      this.subscriptions.set(request.longpollId!, { payoutAddress: request.payoutAddress, resolve, timer });
    });
  }

  async submitBlock(submission: BlockSubmission): Promise<{ valid: boolean; error?: string }> {
    if (!ID_PATTERN.test(submission.templateId) || !Number.isSafeInteger(submission.nonce) || submission.nonce < 0) {
      return { valid: false, error: 'Invalid block submission' };
    }
    const template = this.jobs.get(submission.templateId);
    if (!template || template.expiresAt <= Date.now()) return { valid: false, error: 'Template not found or expired' };
    if (submission.timestamp !== undefined && submission.timestamp !== template.timestamp) {
      return { valid: false, error: 'Submission timestamp does not match template' };
    }

    const block = this.reconstructBlock(template, submission);
    if (BigInt(`0x${block.hash}`) > BigInt(`0x${template.target}`)) {
      return { valid: false, error: 'Invalid proof of work' };
    }
    try {
      return await this.blockchain.addBlock(block);
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async generate(payoutAddress: string): Promise<BlockTemplate> {
    const candidate = await buildBlockCandidate(this.blockchain, this.mempool, payoutAddress);
    const { block, transactions, blockReward, totalFees, blockSizeBytes } = candidate;
    const now = Date.now();
    const template: BlockTemplate = {
      templateId: crypto.randomUUID(),
      createdAt: now,
      expiresAt: now + TEMPLATE_EXPIRY_MS,
      version: 1,
      height: block.index,
      previousHash: block.previousHash,
      merkleRootPlaceholder: block.merkleRoot,
      stateRoot: block.stateRoot,
      timestamp: block.timestamp,
      difficulty: block.difficulty,
      target: difficultyToTarget(block.difficulty).toString(16).padStart(64, '0'),
      bits: difficultyToTarget(block.difficulty).toString(16).padStart(64, '0').slice(0, 8),
      transactions,
      coinbaseTransaction: block.transactions[0],
      coinbaseValue: blockReward + totalFees,
      totalFees,
      blockReward,
      transactionCount: block.transactions.length,
      blockSizeBytes,
      sigOpsCount: transactions.length,
      longpollId: crypto.randomUUID(),
      submitOld: false,
    };
    this.jobs.set(template.templateId, template);
    this.currentByPayout.set(payoutAddress, template.templateId);
    while (this.jobs.size > MAX_JOBS) {
      const oldest = this.jobs.keys().next().value;
      if (!oldest) break;
      this.jobs.delete(oldest);
      for (const [payout, current] of this.currentByPayout) {
        if (current === oldest) this.currentByPayout.delete(payout);
      }
    }
    return template;
  }

  private getCurrent(payoutAddress: string): BlockTemplate | null {
    const id = this.currentByPayout.get(payoutAddress);
    const template = id ? this.jobs.get(id) : undefined;
    return template ?? null;
  }

  private reconstructBlock(template: BlockTemplate, submission: BlockSubmission): BlockClass {
    const block = new BlockClass(
      template.height,
      template.timestamp,
      template.previousHash,
      [template.coinbaseTransaction, ...template.transactions],
      template.difficulty,
      template.coinbaseTransaction.to,
      template.stateRoot
    );
    block.nonce = submission.nonce;
    block.hash = block.calculateHash();
    return block;
  }

  private async refreshSubscriptions(): Promise<void> {
    const payouts = new Set([...this.subscriptions.values()].map(subscription => subscription.payoutAddress));
    this.currentByPayout.clear();
    for (const payoutAddress of payouts) {
      const template = await this.generate(payoutAddress);
      for (const [id, subscription] of this.subscriptions) {
        if (subscription.payoutAddress !== payoutAddress) continue;
        clearTimeout(subscription.timer);
        this.subscriptions.delete(id);
        this.seenLongpoll.set(id, template.templateId);
        subscription.resolve(template);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.blockchain.off('block:added', this.blockHandler);
    this.mempool.off('transactionAdded', this.transactionHandler);
    for (const subscription of this.subscriptions.values()) clearTimeout(subscription.timer);
    this.subscriptions.clear();
    this.jobs.clear();
    this.currentByPayout.clear();
    this.seenLongpoll.clear();
  }
}
