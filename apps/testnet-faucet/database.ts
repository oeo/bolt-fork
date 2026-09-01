import { Database } from 'bun:sqlite';

export type ClaimStatus = 'queued' | 'prepared' | 'submitted' | 'confirmed' | 'blocked';

export interface Claim {
  id: string;
  address: string;
  ipHash: string;
  amount: bigint;
  createdAt: number;
  status: ClaimStatus;
  nonce: number | null;
  transactionHash: string | null;
  payload: string | null;
}

export class FaucetDatabase {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA user_version=1;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        amount TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        nonce INTEGER,
        transaction_hash TEXT,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS claims_address_time ON claims(address, created_at);
      CREATE INDEX IF NOT EXISTS claims_ip_time ON claims(ip_hash, created_at);
      CREATE INDEX IF NOT EXISTS claims_status_time ON claims(status, created_at);
    `);
  }

  createClaim(options: {
    address: string;
    ipHash: string;
    amount: bigint;
    now: number;
    cooldownMs: number;
    windowMs: number;
    globalBudget: bigint;
    capacity: number;
  }): Claim {
    return this.db.transaction(() => {
      const active = this.db.query("SELECT COUNT(*) count FROM claims WHERE status IN ('queued','prepared','submitted')").get() as any;
      if (Number(active.count) >= options.capacity) throw new Error('Faucet queue is full');
      const cutoff = options.now - options.cooldownMs;
      if (this.db.query('SELECT 1 FROM claims WHERE address = ? AND created_at > ? LIMIT 1').get(options.address, cutoff)) {
        throw new Error('Address cooldown active');
      }
      if (this.db.query('SELECT 1 FROM claims WHERE ip_hash = ? AND created_at > ? LIMIT 1').get(options.ipHash, cutoff)) {
        throw new Error('IP cooldown active');
      }
      const rows = this.db.query('SELECT amount FROM claims WHERE created_at > ?').all(options.now - options.windowMs) as any[];
      const spent = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
      if (spent + options.amount > options.globalBudget) throw new Error('Faucet daily budget exhausted');
      const claim: Claim = {
        id: crypto.randomUUID(),
        address: options.address,
        ipHash: options.ipHash,
        amount: options.amount,
        createdAt: options.now,
        status: 'queued',
        nonce: null,
        transactionHash: null,
        payload: null,
      };
      this.db.query(`INSERT INTO claims
        (id,address,ip_hash,amount,created_at,status,nonce,transaction_hash,payload)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        claim.id, claim.address, claim.ipHash, claim.amount.toString(), claim.createdAt,
        claim.status, null, null, null
      );
      return claim;
    })();
  }

  nextWork(): Claim | null {
    const row = this.db.query("SELECT * FROM claims WHERE status IN ('prepared','submitted','queued') ORDER BY created_at LIMIT 1").get();
    return row ? fromRow(row as any) : null;
  }

  get(id: string): Claim | null {
    const row = this.db.query('SELECT * FROM claims WHERE id = ?').get(id);
    return row ? fromRow(row as any) : null;
  }

  prepare(id: string, nonce: number, hash: string, payload: string): void {
    this.db.query("UPDATE claims SET status='prepared', nonce=?, transaction_hash=?, payload=? WHERE id=? AND status='queued'")
      .run(nonce, hash, payload, id);
  }

  setStatus(id: string, status: ClaimStatus): void {
    this.db.query('UPDATE claims SET status=? WHERE id=?').run(status, id);
  }

  close(): void {
    this.db.close();
  }
}

function fromRow(row: any): Claim {
  return {
    id: row.id,
    address: row.address,
    ipHash: row.ip_hash,
    amount: BigInt(row.amount),
    createdAt: row.created_at,
    status: row.status,
    nonce: row.nonce,
    transactionHash: row.transaction_hash,
    payload: row.payload,
  };
}
