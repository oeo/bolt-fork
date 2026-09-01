import { StorageAdapter } from './adapter';
import { MemoryAdapter } from './memory';
import { LMDBAdapter } from './lmdb-adapter';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

export type StorageType = 'memory' | 'lmdb';

interface StorageConfig {
  type: StorageType;
  readOnly?: boolean;
  lmdb?: {
    path?: string;
    mapSize?: number;
  };
}

/**
 * create a storage adapter based on configuration
 * accepts either a string type or full config object
 */
export function createStorage(
  typeOrConfig: StorageType | (StorageConfig & { path?: string; mapSize?: number })
): StorageAdapter {
  // handle both old and new config formats
  let config: StorageConfig;
  
  if (typeof typeOrConfig === 'string') {
    config = { type: typeOrConfig };
  } else {
    config = typeOrConfig;
  }
  
  let adapter: StorageAdapter;
  
  switch (config.type) {
    case 'memory':
      adapter = new MemoryAdapter();
      break;
      
    case 'lmdb':
      const lmdbConfig = config.lmdb || {};
      const legacyConfig: { path?: string; mapSize?: number; readOnly?: boolean } =
        typeof typeOrConfig === 'string' ? {} : typeOrConfig;
      const lmdbPath = lmdbConfig.path || legacyConfig.path || './data/lmdb';
      adapter = new LMDBAdapter({
        path: lmdbPath,
        mapSize: lmdbConfig.mapSize || legacyConfig.mapSize || 100 * 1024 * 1024 * 1024,
        readOnly: config.readOnly || legacyConfig.readOnly,
      });
      break;
      
    default:
      throw new Error(`Unknown storage type: ${config.type}`);
  }
  
  logger.info(`Created ${config.type} storage adapter`);
  
  return adapter;
}

/**
 * create storage from environment variables
 */
export function createStorageFromEnv(): StorageAdapter {
  const type = (process.env.STORAGE_TYPE || 'lmdb') as StorageType;
  
  const config: StorageConfig = {
    type,
    lmdb: {
      path: process.env.LMDB_PATH || './data/lmdb',
      mapSize: parseInt(process.env.LMDB_MAP_SIZE || String(100 * 1024 * 1024 * 1024)) // 100GB default
    }
  };
  
  return createStorage(config);
}

// re-export types
export { StorageAdapter } from './adapter';
export { MemoryAdapter } from './memory';
