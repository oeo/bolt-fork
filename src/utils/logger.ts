import pino from 'pino';
import fs from 'fs';
import path from 'path';

// create pino logger instance
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname'
    }
  },
  base: {
    network: process.env.BOLT_NETWORK || 'testnet'
  }
});

// cache for child loggers
const childLoggers: Record<string, pino.Logger> = {};

// get logger based on calling file's location
export function getLogger(filePath?: string): pino.Logger {
  // if no filepath provided, try to get from stack trace
  if (!filePath) {
    const stack = new Error().stack;
    if (stack) {
      const lines = stack.split('\n');
      // find first line that contains a file path (skip this function)
      for (let i = 2; i < lines.length; i++) {
        const match = lines[i].match(/\((.+)\)/);
        if (match && match[1]) {
          filePath = match[1].split(':')[0];
          break;
        }
      }
    }
  }
  
  if (!filePath) {
    return logger;
  }
  
  // extract domain from file path
  const srcIndex = filePath.indexOf('/src/');
  if (srcIndex === -1) {
    return logger;
  }
  
  const relativePath = filePath.substring(srcIndex + 5);
  const parts = relativePath.split('/');
  
  // if file is directly in src/, use 'root' as domain
  if (parts.length === 1) {
    if (!childLoggers.root) {
      childLoggers.root = logger.child({ domain: 'root' });
    }
    return childLoggers.root;
  }
  
  // use first folder as domain
  const domain = parts[0];
  
  // create child logger if not cached
  if (!childLoggers[domain]) {
    childLoggers[domain] = logger.child({ domain });
  }
  
  return childLoggers[domain];
}

// display ASCII art banner
export function displayBanner() {
  try {
    const asciiPath = path.join(process.cwd(), 'ascii.art');
    const art = fs.readFileSync(asciiPath, 'utf8');
    console.log(art);
  } catch (err) {
    logger.warn('Could not display ASCII banner');
  }
}

export default logger;