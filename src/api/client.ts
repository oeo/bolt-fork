import type { Transaction } from '../types';
import { deserialize, serialize } from '../utils/bigint';

export interface ChainInfo {
  network: string;
  chainId: number;
  genesisHash: string;
  addressPrefix: number;
  minFeePerByte: bigint;
  maxTransactionSize: number;
  protocolVersion: number;
  height: number;
  latestBlockHash?: string;
}

export interface AccountAdmissionState {
  address: string;
  confirmedBalance: bigint;
  confirmedNonce: number;
  availableBalance: bigint;
  nextNonce: number;
}

export class BoltApiClient {
  readonly origin: string;

  constructor(origin: string) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      throw new Error('Remote bolt API must use HTTPS');
    }
    this.origin = url.origin;
  }

  chainInfo(): Promise<ChainInfo> {
    return this.request('/blockchain/info');
  }

  accountState(address: string): Promise<AccountAdmissionState> {
    return this.request(`/accounts/${encodeURIComponent(address)}/state`);
  }

  transaction(hash: string): Promise<any> {
    return this.request(`/transactions/${hash}`);
  }

  async submit(transaction: Transaction): Promise<{ hash: string; accepted: boolean }> {
    return this.request('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialize(transaction),
    });
  }

  private async request(path: string, init?: RequestInit): Promise<any> {
    const response = await fetch(`${this.origin}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let value: any;
    try {
      value = deserialize(text);
    } catch {
      throw new Error(`Invalid bolt API response (${response.status})`);
    }
    if (!response.ok) {
      const error = new Error(value?.error || `bolt API request failed (${response.status})`);
      (error as any).code = value?.code;
      throw error;
    }
    return value;
  }
}
