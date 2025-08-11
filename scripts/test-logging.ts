#!/usr/bin/env bun

import { getLogger } from '../src/utils/logger';

const logger = getLogger(__filename);

// test all log levels
logger.trace('this is a trace message', { detail: 'trace data' });
logger.debug('this is a debug message', { detail: 'debug data' });
logger.info('this is an info message', { detail: 'info data' });
logger.warn('this is a warning message', { detail: 'warning data' });
logger.error('this is an error message', new Error('test error'));
logger.fatal('this is a fatal message', { critical: true });

// test child logger with domain
const apiLogger = getLogger('/src/api/server.ts');
apiLogger.info('api server started', { port: 7333 });

const blockchainLogger = getLogger('/src/core/blockchain.ts');
blockchainLogger.debug('adding block', { height: 1, hash: '0x123...' });

// test large object
const largeObject = {
  blocks: Array(10).fill(null).map((_, i) => ({
    height: i,
    hash: `0x${i.toString(16).padStart(64, '0')}`,
    transactions: []
  }))
};
logger.info('large object test', largeObject);

// simulate async error
setTimeout(() => {
  logger.error('async error occurred', new Error('async test error'));
}, 100);

// check log files
setTimeout(() => {
  console.log('\nchecking log files...');
  import('fs').then(fs => {
    const logDir = 'logs';
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir);
      console.log('log files created:', files);
      
      // show last few lines of main log
      if (files.includes('bolt.log')) {
        const content = fs.readFileSync(`${logDir}/bolt.log`, 'utf-8');
        const lines = content.trim().split('\n');
        console.log('\nlast 5 lines of bolt.log:');
        lines.slice(-5).forEach(line => console.log(line));
      }
      
      // show error log
      if (files.includes('error.log')) {
        const content = fs.readFileSync(`${logDir}/error.log`, 'utf-8');
        console.log('\nerror.log content:');
        console.log(content);
      }
    }
  });
}, 200);