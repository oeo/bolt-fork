import { StorageAdapter } from './adapter';
import { MemoryAdapter } from './memory';
import { RedisAdapter } from './redis';
import { LMDBAdapter } from './lmdb-adapter';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

export type StorageType = 'redis' | 'memory' | 'lmdb';

interface StorageConfig {
  type: StorageType;
  redis?: {
    host?: string;
    port?: number;
    db?: number;
  };
  lmdb?: {
    path?: string;
    mapSize?: number;
  };
}

/**
 * create a storage adapter based on configuration
 * accepts either a string type or full config object
 */
export function createStorage(typeOrConfig: StorageType | StorageConfig | any): StorageAdapter {
  // handle both old and new config formats
  let config: StorageConfig;
  
  if (typeof typeOrConfig === 'string') {
    config = { type: typeOrConfig };
  } else if (typeOrConfig.type === 'redis' && (typeOrConfig.host || typeOrConfig.port)) {
    // new format with direct properties
    config = {
      type: 'redis',
      redis: {
        host: typeOrConfig.host,
        port: typeOrConfig.port,
        db: typeOrConfig.db
      }
    };
  } else {
    config = typeOrConfig;
  }
  
  let adapter: StorageAdapter;
  
  switch (config.type) {
    case 'redis':
      const redisConfig = config.redis || {};
      adapter = new RedisAdapter(
        redisConfig.host || typeOrConfig.host || 'localhost',
        redisConfig.port || typeOrConfig.port || 7337,
        redisConfig.db || typeOrConfig.db || 0,
        typeOrConfig.keyPrefix || '',
        typeOrConfig.password
      );
      break;
      
    case 'memory':
      adapter = new MemoryAdapter();
      break;
      
    case 'lmdb':
      const lmdbConfig = config.lmdb || {};
      const lmdbPath = lmdbConfig.path || typeOrConfig.path || './data/lmdb';
      adapter = new LMDBAdapter({
        path: lmdbPath,
        mapSize: lmdbConfig.mapSize || typeOrConfig.mapSize || 100 * 1024 * 1024 * 1024 // 100GB default
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
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '7337'),
      db: parseInt(process.env.REDIS_DB || '0')
    },
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
export { RedisAdapter } from './redis';