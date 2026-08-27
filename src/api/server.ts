import { serve } from 'bun';
import { Blockchain } from '../core/blockchain';
import type { Block } from '../core/block';
import { Mempool } from '../core/mempool';
import { StorageAdapter } from '../storage/adapter';
import { getLogger } from '../utils/logger';
import { formatWatts } from '../utils/currency';
import { serialize, deserialize } from '../utils/bigint';
import { getMetricsService } from '../services/metrics';
import { validateAddress } from '../crypto/address';
import type { GetBlockTemplateService } from '../services/getblocktemplate';
import { timingSafeEqual } from 'node:crypto';

const logger = getLogger(__filename);
const MAX_REQUEST_BODY_SIZE = 128 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly metricType: 'bad_request' | 'not_found' | 'method_not_allowed' | 'internal'
  ) {
    super(message);
  }
}

export interface ApiServerConfig {
  port?: number;
  host?: string;
  blockchain: Blockchain;
  mempool: Mempool;
  storage: StorageAdapter;
  mining?: {
    enabled: boolean;
    token?: string;
    service: GetBlockTemplateService;
    maxConcurrentRequests?: number;
    maxSubmissionsPerMinute?: number;
  };
}

/**
 * rest api server for bolt blockchain
 */
export class ApiServer {
  private server: any;
  private config: ApiServerConfig;
  private started: boolean = false;
  private activeMiningRequests = 0;
  private submissionWindow = { startedAt: 0, count: 0 };

  constructor(config: ApiServerConfig) {
    if (config.mining?.enabled && (!config.mining.token || config.mining.token.length > 1024)) {
      throw new Error('Mining API token is required when mining API is enabled');
    }
    this.config = config;
  }

  /**
   * start the api server
   */
  async start(): Promise<void> {
    if (this.started) {
      logger.warn('API server already started');
      return;
    }

    const port = this.config.port || parseInt(process.env.API_PORT || '7333');
    const host = this.config.host || '127.0.0.1';

    this.server = serve({
      port,
      hostname: host,
      maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
      fetch: this.handleRequest.bind(this),
    });

    this.started = true;
    logger.info(`API server started on http://${host}:${port}`);
  }

  /**
   * handle incoming http requests
   */
  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const startTime = Date.now();
    const endpoint = this.matchEndpoint(path);
    let response: Response;

    try {
      if (endpoint === 'unmatched') throw new ApiError(404, 'Endpoint not found', 'not_found');
      const allowedMethod = endpoint === '/transactions' || endpoint.startsWith('/mining/') ? 'POST' : 'GET';
      if (method !== allowedMethod) throw new ApiError(405, 'Method not allowed', 'method_not_allowed');

      let result: unknown;
      if (endpoint === '/blocks') result = await this.getBlocks(url);
      else if (endpoint === '/blocks/:id') result = await this.getBlock(path.slice('/blocks/'.length));
      else if (endpoint === '/blockchain/info') result = await this.getBlockchainInfo();
      else if (endpoint === '/transactions') result = await this.submitTransaction(await this.readJson(req));
      else if (endpoint === '/transactions/:hash') result = await this.getTransaction(path.slice('/transactions/'.length));
      else if (endpoint === '/accounts/:address/balance') result = await this.getBalance(path.split('/')[2]);
      else if (endpoint === '/accounts/:address/nonce') result = await this.getNonce(path.split('/')[2]);
      else if (endpoint === '/mempool') result = await this.getMempoolInfo();
      else if (endpoint === '/mempool/transactions') result = this.getMempoolTransactions(url);
      else if (endpoint === '/mining/template') result = await this.handleMiningRequest(req, false);
      else if (endpoint === '/mining/submit') result = await this.handleMiningRequest(req, true);
      else result = { status: 'ok', timestamp: Date.now() };

      response = new Response(serialize(result), { status: 200, headers: JSON_HEADERS });
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : new ApiError(500, 'Internal server error', 'internal');
      if (apiError.status === 500) logger.error('API request failed', error);
      response = new Response(
        JSON.stringify({ error: apiError.message }),
        { status: apiError.status, headers: JSON_HEADERS }
      );
      getMetricsService().recordApiError(method, endpoint, apiError.metricType);
    }

    getMetricsService().recordApiRequest(
      method,
      endpoint,
      response.status,
      (Date.now() - startTime) / 1000
    );
    return response;
  }

  private matchEndpoint(path: string): string {
    if (this.config.mining?.enabled && (path === '/mining/template' || path === '/mining/submit')) return path;
    if (
      path === '/health' ||
      path === '/blockchain/info' ||
      path === '/blocks' ||
      path === '/transactions' ||
      path === '/mempool' ||
      path === '/mempool/transactions'
    ) return path;
    if (/^\/blocks\/[^/]+$/.test(path)) return '/blocks/:id';
    if (/^\/transactions\/[^/]+$/.test(path)) return '/transactions/:hash';
    if (/^\/accounts\/[^/]+\/balance$/.test(path)) return '/accounts/:address/balance';
    if (/^\/accounts\/[^/]+\/nonce$/.test(path)) return '/accounts/:address/nonce';
    return 'unmatched';
  }

  private async handleMiningRequest(req: Request, submission: boolean): Promise<unknown> {
    const mining = this.config.mining!;
    const authorization = req.headers.get('authorization') ?? '';
    const expected = `Bearer ${mining.token}`;
    const digest = (value: string): Buffer => {
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(value);
      return Buffer.from(hasher.digest());
    };
    if (!timingSafeEqual(digest(authorization), digest(expected))) {
      throw new ApiError(401, 'Unauthorized', 'bad_request');
    }
    if (this.activeMiningRequests >= (mining.maxConcurrentRequests ?? 8)) {
      throw new ApiError(429, 'Mining request concurrency limit reached', 'bad_request');
    }

    this.activeMiningRequests++;
    try {
      const body = await this.readJson(req);
      if (!submission) {
        const keys = Object.keys(body);
        if (keys.some(key => key !== 'payoutAddress' && key !== 'longpollId') ||
            typeof body.payoutAddress !== 'string' || body.payoutAddress.length > 35 ||
            (body.longpollId !== undefined && (typeof body.longpollId !== 'string' || body.longpollId.length > 64))) {
          throw new ApiError(400, 'Invalid template request', 'bad_request');
        }
        this.assertAddress(body.payoutAddress);
        return mining.service.getBlockTemplate({
          payoutAddress: body.payoutAddress,
          longpollId: body.longpollId as string | undefined,
        });
      }

      const now = Date.now();
      if (now - this.submissionWindow.startedAt >= 60_000) this.submissionWindow = { startedAt: now, count: 0 };
      if (++this.submissionWindow.count > (mining.maxSubmissionsPerMinute ?? 60)) {
        throw new ApiError(429, 'Mining submission rate limit reached', 'bad_request');
      }
      const keys = Object.keys(body);
      if (keys.some(key => key !== 'templateId' && key !== 'nonce' && key !== 'timestamp') ||
          typeof body.templateId !== 'string' || body.templateId.length > 64 ||
          !Number.isSafeInteger(body.nonce) || (body.nonce as number) < 0 ||
          (body.timestamp !== undefined && (!Number.isSafeInteger(body.timestamp) || (body.timestamp as number) < 0))) {
        throw new ApiError(400, 'Invalid block submission', 'bad_request');
      }
      return mining.service.submitBlock({
        templateId: body.templateId,
        nonce: body.nonce as number,
        timestamp: body.timestamp as number | undefined,
      });
    } finally {
      this.activeMiningRequests--;
    }
  }

  private async readJson(req: Request): Promise<Record<string, unknown>> {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) {
      throw new ApiError(415, 'Content-Type must be application/json', 'bad_request');
    }
    const text = await req.text();
    if (!text) throw new ApiError(400, 'Request body is required', 'bad_request');
    try {
      const value = deserialize(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new ApiError(400, 'Invalid JSON body', 'bad_request');
    }
  }

  private parsePagination(url: URL): { limit: number; offset: number } {
    for (const key of url.searchParams.keys()) {
      if (key !== 'limit' && key !== 'offset') {
        throw new ApiError(400, `Unknown query parameter: ${key}`, 'bad_request');
      }
    }
    if (url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('offset').length > 1) {
      throw new ApiError(400, 'Duplicate pagination parameter', 'bad_request');
    }
    const limit = this.parseUnsignedInteger(url.searchParams.get('limit') ?? '10', 'limit');
    const offset = this.parseUnsignedInteger(url.searchParams.get('offset') ?? '0', 'offset');
    if (limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new ApiError(400, `limit must be between 1 and ${MAX_PAGE_SIZE}`, 'bad_request');
    }
    return { limit, offset };
  }

  private parseUnsignedInteger(value: string, name: string): number {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
      throw new ApiError(400, `${name} must be a non-negative integer`, 'bad_request');
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new ApiError(400, `${name} exceeds the safe integer range`, 'bad_request');
    }
    return number;
  }

  private assertHash(hash: string): void {
    if (!/^[a-f\d]{64}$/.test(hash)) throw new ApiError(400, 'Invalid hash', 'bad_request');
  }

  private assertAddress(address: string): void {
    if (!validateAddress(address, this.config.blockchain.getChainConfig().addressPrefix)) {
      throw new ApiError(400, 'Invalid address', 'bad_request');
    }
  }

  /**
   * get blocks with pagination
   */
  private async getBlocks(url: URL): Promise<any> {
    const { limit, offset } = this.parsePagination(url);

    const height = await this.config.blockchain.getHeight();
    const blocks: Block[] = [];
    let responseBytes = 0;

    if (offset > height) {
      return { blocks, total: height + 1, limit, offset, count: 0 };
    }

    for (let i = height - offset; i >= Math.max(0, height - offset - limit + 1); i--) {
      const block = await this.config.blockchain.getBlock(i);
      if (block) {
        const blockBytes = new TextEncoder().encode(serialize(block)).byteLength;
        if (responseBytes + blockBytes > MAX_RESPONSE_BYTES) break;
        blocks.push(block);
        responseBytes += blockBytes;
      }
    }

    return {
      blocks,
      total: height + 1,
      limit,
      offset,
      count: blocks.length,
    };
  }

  /**
   * get single block by hash or height
   */
  private async getBlock(hashOrHeight: string): Promise<any> {
    // check if it's a number (height) or hash
    const isHeight = /^\d+$/.test(hashOrHeight);

    if (isHeight) {
      const height = this.parseUnsignedInteger(hashOrHeight, 'height');
      const block = await this.config.blockchain.getBlock(height);
      if (!block) {
        throw new ApiError(404, 'Block not found', 'not_found');
      }
      return block;
    } else {
      this.assertHash(hashOrHeight);
      const block = await this.config.blockchain.getBlockByHash(hashOrHeight);
      if (!block) {
        throw new ApiError(404, 'Block not found', 'not_found');
      }
      return block;
    }
  }

  /**
   * get blockchain info
   */
  private async getBlockchainInfo(): Promise<any> {
    const height = await this.config.blockchain.getHeight();
    const latestBlock = await this.config.blockchain.getLatestBlock();
    const difficulty = await this.config.blockchain.getDifficulty();
    const cumulativeDifficulty = await this.config.blockchain.getCumulativeDifficulty();
    const chainConfig = this.config.blockchain.getChainConfig();

    return {
      network: chainConfig.name,
      height,
      latestBlockHash: latestBlock?.hash,
      difficulty,
      cumulativeDifficulty,
      targetBlockTime: chainConfig.targetBlockTime,
      difficultyAdjustmentInterval: chainConfig.difficultyAdjustmentInterval,
      maxSupply: formatWatts(chainConfig.maxSupply),
      currentReward: formatWatts(this.config.blockchain.calculateBlockReward(height + 1))
    };
  }

  /**
   * submit a transaction
   */
  private async submitTransaction(txData: any): Promise<any> {
    try {
      await this.config.mempool.addTransaction(txData);
    } catch (error) {
      logger.debug('Transaction rejected by mempool', error);
      throw new ApiError(400, 'Transaction rejected', 'bad_request');
    }

    return {
      hash: txData.hash,
      accepted: true,
    };
  }

  /**
   * get transaction by hash
   */
  private async getTransaction(hash: string): Promise<any> {
    this.assertHash(hash);
    // check mempool first
    const mempoolTx = this.config.mempool.getTransaction(hash);
    if (mempoolTx) {
      return {
        ...mempoolTx,
        status: 'pending',
        confirmations: 0
      };
    }

    // check blockchain
    const confirmed = await this.config.storage.getConfirmedTransaction(hash);
    if (!confirmed) throw new ApiError(404, 'Transaction not found', 'not_found');

    return {
      ...confirmed.transaction,
      status: 'confirmed',
      confirmations: confirmed.canonicalHeight - confirmed.blockHeight + 1,
      blockHeight: confirmed.blockHeight,
      blockHash: confirmed.blockHash,
    };
  }

  /**
   * get account balance
   */
  private async getBalance(address: string): Promise<any> {
    this.assertAddress(address);
    const balance = await this.config.blockchain.getBalance(address);

    return {
      address,
      balance,
      formatted: formatWatts(balance)
    };
  }

  /**
   * get account nonce
   */
  private async getNonce(address: string): Promise<any> {
    this.assertAddress(address);
    const nonce = await this.config.blockchain.getNonce(address);

    return {
      address,
      nonce
    };
  }

  /**
   * get mempool info
   */
  private async getMempoolInfo(): Promise<any> {
    const stats = this.config.mempool.getStats();

    return {
      size: stats.size,
      bytes: stats.bytes,
      minFeePerByte: stats.minFeePerByte,
      maxFeePerByte: stats.maxFeePerByte,
      averageFeePerByte: stats.avgFeePerByte,
      totalFees: formatWatts(stats.totalFees)
    };
  }

  /**
   * get mempool transactions
   */
  private getMempoolTransactions(url: URL): any {
    const { limit, offset } = this.parsePagination(url);
    const transactions = this.config.mempool.getTransactions();
    const page = [];
    let responseBytes = 0;
    for (const transaction of transactions.slice(offset, offset + limit)) {
      const transactionBytes = new TextEncoder().encode(serialize(transaction)).byteLength;
      if (responseBytes + transactionBytes > MAX_RESPONSE_BYTES) break;
      page.push(transaction);
      responseBytes += transactionBytes;
    }

    return {
      transactions: page,
      total: transactions.length,
      limit,
      offset,
      count: page.length,
    };
  }

  /**
   * stop the api server
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.server) {
      this.server.stop();
    }

    this.started = false;
    logger.info('API server stopped');
  }
}
