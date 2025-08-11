import fs from 'fs';
import path from 'path';
import { getLogger as getFileLogger } from './file-logger';

// re-export file logger as the main logger
export const logger = getFileLogger();

// maintain backward compatibility with pino-like interface
export function getLogger(filePath?: string) {
  return getFileLogger(filePath);
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