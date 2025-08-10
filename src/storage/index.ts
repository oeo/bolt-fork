import { StorageAdapter } from './adapter';
import { MemoryAdapter } from './memory';
import { RedisAdapter } from './redis';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

export type StorageType = 'redis' | 'memory' | 'leveldb';

interface StorageConfig {
  type: StorageType;
  redis?: {
    host?: string;
    port?: number;
    db?: number;
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
      
    case 'leveldb':
      // placeholder for future leveldb implementation
      throw new Error('LevelDB adapter not yet implemented');
      
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
  const type = (process.env.STORAGE_TYPE || 'memory') as StorageType;
  
  const config: StorageConfig = {
    type,
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '7337'),
      db: parseInt(process.env.REDIS_DB || '0')
    }
  };
  
  return createStorage(config);
}

// re-export types
export { StorageAdapter } from './adapter';
export { MemoryAdapter } from './memory';
export { RedisAdapter } from './redis';