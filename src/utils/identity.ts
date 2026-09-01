import fs from 'fs';
import path from 'path';
import { generateAddress, generateFromPrivateKey, type KeyInfo } from '../crypto/address';
import { sign, verify } from '../crypto/signature';
import { getLogger } from './logger';

const logger = getLogger(__filename);

export interface NodeIdentity {
  address: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
  nodeAlias?: string;
}

/**
 * manages node identity with persistence
 */
export class IdentityManager {
  private identityPath: string;
  private addressPrefix: number;
  private identity: NodeIdentity | null = null;

  constructor(dataDir: string = './data', addressPrefix: number = 0x00) {
    this.identityPath = path.join(dataDir, '.identity');
    this.addressPrefix = addressPrefix;
  }

  /**
   * load or create node identity
   */
  async loadOrCreate(): Promise<NodeIdentity> {
    // check if identity file exists
    if (fs.existsSync(this.identityPath)) {
      fs.chmodSync(this.identityPath, 0o600);
      return this.loadExisting();
    }

    // generate new identity
    return this.createNew();
  }

  loadExisting(): NodeIdentity {
    const identity = JSON.parse(fs.readFileSync(this.identityPath, 'utf8')) as NodeIdentity;
    const derived = generateFromPrivateKey(identity.privateKey, this.addressPrefix);
    if (identity.address !== derived.address || identity.publicKey !== derived.publicKey) {
      throw new Error('stored node identity does not match its private key or active network');
    }
    this.identity = identity;
    logger.info(`loaded node identity: ${identity.address}`);
    return identity;
  }

  /**
   * create new node identity
   */
  private createNew(): NodeIdentity {
    logger.info('generating new node identity...');
    
    // generate new keypair
    const keyInfo: KeyInfo = generateAddress(this.addressPrefix);
    
    // create identity object
    this.identity = {
      address: keyInfo.address,
      publicKey: keyInfo.publicKey,
      privateKey: keyInfo.privateKey,
      createdAt: Date.now(),
      nodeAlias: process.env.NODE_ALIAS
    };

    // save to file
    this.save();
    
    logger.info(`created new node identity: ${this.identity.address}`);
    return this.identity;
  }

  /**
   * save identity to file
   */
  private save(): void {
    if (!this.identity) {
      throw new Error('no identity to save');
    }

    // ensure directory exists
    const dir = path.dirname(this.identityPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = JSON.stringify(this.identity, null, 2);
    const temporaryPath = `${this.identityPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const file = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(file, data);
      fs.fsyncSync(file);
    } finally {
      fs.closeSync(file);
    }
    try {
      fs.renameSync(temporaryPath, this.identityPath);
      const directory = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
    logger.debug('saved identity to file');
  }

  /**
   * get current identity
   */
  getIdentity(): NodeIdentity | null {
    return this.identity;
  }

  /**
   * get node id (address)
   */
  getNodeId(): string {
    if (!this.identity) {
      throw new Error('identity not loaded');
    }
    return this.identity.address;
  }

  /**
   * get display name for node
   */
  getDisplayName(): string {
    if (!this.identity) {
      throw new Error('identity not loaded');
    }
    
    // use alias if available, otherwise truncated address
    if (this.identity.nodeAlias) {
      return this.identity.nodeAlias;
    }
    
    // show first 8 chars of address
    return this.identity.address.substring(0, 8);
  }

  /**
   * sign data with node's private key
   */
  async sign(data: Uint8Array): Promise<string> {
    if (!this.identity) {
      throw new Error('identity not loaded');
    }
    return sign(data, this.identity.privateKey);
  }

  /**
   * verify signature with public key
   */
  async verify(data: Uint8Array, signature: string, publicKey: string): Promise<boolean> {
    return verify(data, signature, publicKey);
  }

  /**
   * export identity (without private key)
   */
  exportPublic(): { address: string; publicKey: string; nodeAlias?: string } {
    if (!this.identity) {
      throw new Error('identity not loaded');
    }
    
    return {
      address: this.identity.address,
      publicKey: this.identity.publicKey,
      nodeAlias: this.identity.nodeAlias
    };
  }

  /**
   * import identity from existing keypair
   */
  importFromKeyInfo(keyInfo: KeyInfo, alias?: string): NodeIdentity {
    const derived = generateFromPrivateKey(keyInfo.privateKey, this.addressPrefix);
    if (derived.address !== keyInfo.address || derived.publicKey !== keyInfo.publicKey) {
      throw new Error('imported node identity does not match its private key or active network');
    }
    this.identity = {
      address: keyInfo.address,
      publicKey: keyInfo.publicKey,
      privateKey: keyInfo.privateKey,
      createdAt: Date.now(),
      nodeAlias: alias
    };

    this.save();
    logger.info(`imported identity: ${this.identity.address}`);
    return this.identity;
  }
}
