import type { AccountState } from '../types';
import type { AccountChange } from './adapter';
import { LMDBManager } from './lmdb-manager';

export interface Account extends AccountState {
  address: string;
}

export class LMDBStateStore {
  constructor(private lmdb: LMDBManager) {}

  async getAccountState(address: string): Promise<AccountState | null> {
    const account = this.readAccount(address);
    return account ? { balance: account.balance, nonce: account.nonce } : null;
  }

  readAccount(address: string): Account | null {
    const data = this.lmdb.accounts.get(address);
    return data ? this.deserializeAccount(data) : null;
  }

  async updateAccountState(address: string, state: AccountState): Promise<void> {
    await this.lmdb.accounts.put(address, this.serializeAccount({ address, ...state }));
  }

  writeChanges(changes: readonly AccountChange[]): void {
    for (const { address, state } of changes) {
      if (state) this.lmdb.accounts.putSync(address, this.serializeAccount({ address, ...state }));
      else this.lmdb.accounts.removeSync(address);
    }
  }

  async getAllAccountAddresses(): Promise<string[]> {
    const addresses: string[] = [];
    for await (const { key } of this.lmdb.accounts.getRange()) addresses.push(String(key));
    return addresses;
  }

  private serializeAccount(account: Account): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
      address: account.address,
      balance: account.balance.toString(),
      nonce: account.nonce,
    }));
  }

  private deserializeAccount(data: Uint8Array): Account {
    const account = JSON.parse(new TextDecoder().decode(data));
    return { ...account, balance: BigInt(account.balance) };
  }
}
