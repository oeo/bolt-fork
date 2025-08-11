import fs from 'fs';
import path from 'path';
import { generateAddress, generateFromPrivateKey, type KeyInfo } from '../crypto/address';
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
  private identity: NodeIdentity | null = null;

  constructor(dataDir: string = './data') {
    this.identityPath = path.join(dataDir, '.identity');
  }

  /**
   * load or create node identity
   */
  async loadOrCreate(): Promise<NodeIdentity> {
    // check if identity file exists
    if (fs.existsSync(this.identityPath)) {
      try {
        const data = fs.readFileSync(this.identityPath, 'utf8');
        this.identity = JSON.parse(data);
        logger.info(`loaded node identity: ${this.identity!.address}`);
        return this.identity!;
      } catch (error) {
        logger.error('failed to load identity file, generating new identity', error);
      }
    }

    // generate new identity
    return this.createNew();
  }

  /**
   * create new node identity
   */
  private createNew(): NodeIdentity {
    logger.info('generating new node identity...');
    
    // generate new keypair
    const keyInfo: KeyInfo = generateAddress();
    
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

    // write identity file with restricted permissions
    const data = JSON.stringify(this.identity, null, 2);
    fs.writeFileSync(this.identityPath, data, { mode: 0o600 });
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
  sign(data: Uint8Array): string {
    if (!this.identity) {
      throw new Error('identity not loaded');
    }
    
    // implement signing with private key
    // for now, return a placeholder
    return 'signature';
  }

  /**
   * verify signature with public key
   */
  verify(data: Uint8Array, signature: string, publicKey: string): boolean {
    // implement signature verification
    // for now, return true
    return true;
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