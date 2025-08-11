import fs from 'fs';
import path from 'path';
import { createWriteStream, WriteStream } from 'fs';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
};

interface LoggerOptions {
  level?: LogLevel;
  dir?: string;
  maxFileSize?: number;
  maxFiles?: number;
  console?: boolean;
}

class FileLogger {
  private level: LogLevel;
  private dir: string;
  private maxFileSize: number;
  private maxFiles: number;
  private console: boolean;
  private stream: WriteStream | null = null;
  private errorStream: WriteStream | null = null;
  private currentSize: number = 0;
  private domain?: string;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level || (process.env.LOG_LEVEL as LogLevel) || 'info';
    this.dir = options.dir || process.env.LOG_DIR || path.join(process.cwd(), 'logs');
    this.maxFileSize = options.maxFileSize || 50 * 1024 * 1024; // 50MB default
    this.maxFiles = options.maxFiles || 5;
    this.console = options.console !== undefined ? options.console : process.env.NODE_ENV !== 'production';
    
    this.ensureLogDir();
    this.openStreams();
  }

  private ensureLogDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private openStreams() {
    const logPath = path.join(this.dir, 'bolt.log');
    const errorPath = path.join(this.dir, 'error.log');
    
    this.stream = createWriteStream(logPath, { flags: 'a' });
    this.errorStream = createWriteStream(errorPath, { flags: 'a' });
    
    // get current file size
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      this.currentSize = stats.size;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(level: LogLevel, message: string, data?: any): string {
    // compact timestamp: HH:MM:SS.mmm
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    
    // compact level: first letter uppercase
    const levelChar = level[0].toUpperCase();
    
    // always show domain/filename
    const domain = this.domain || 'main';
    
    let formatted = `${time} ${levelChar} [${domain}] ${message}`;
    
    if (data !== undefined) {
      if (data instanceof Error) {
        formatted += `: ${data.message}`;
        if (data.stack && level === 'error' || level === 'fatal') {
          // stack trace on separate lines without indentation
          const stackLines = data.stack.split('\n').map(line => line.trim());
          formatted += '\n' + stackLines.join('\n');
        }
      } else if (typeof data === 'object') {
        try {
          // compact JSON on same line
          formatted += ` ${JSON.stringify(data)}`;
        } catch {
          formatted += ` [circular]`;
        }
      } else {
        formatted += ` ${data}`;
      }
    }
    
    return formatted + '\n';
  }

  private async rotateLog() {
    if (!this.stream) return;
    
    this.stream.end();
    
    const logPath = path.join(this.dir, 'bolt.log');
    
    // rotate old files
    for (let i = this.maxFiles - 1; i > 0; i--) {
      const oldPath = i === 1 ? logPath : `${logPath}.${i - 1}`;
      const newPath = `${logPath}.${i}`;
      
      if (fs.existsSync(oldPath)) {
        if (i === this.maxFiles && fs.existsSync(newPath)) {
          fs.unlinkSync(newPath);
        }
        fs.renameSync(oldPath, newPath);
      }
    }
    
    // open new stream
    this.stream = createWriteStream(logPath, { flags: 'a' });
    this.currentSize = 0;
  }

  private writeLog(level: LogLevel, message: string, data?: any) {
    if (!this.shouldLog(level)) return;
    
    const formatted = this.formatMessage(level, message, data);
    const bytes = Buffer.byteLength(formatted);
    
    // check if rotation needed
    if (this.currentSize + bytes > this.maxFileSize) {
      this.rotateLog();
    }
    
    // write to file
    if (this.stream && !this.stream.destroyed) {
      this.stream.write(formatted);
      this.currentSize += bytes;
    }
    
    // write errors to error log
    if ((level === 'error' || level === 'fatal') && this.errorStream && !this.errorStream.destroyed) {
      this.errorStream.write(formatted);
    }
    
    // console output
    if (this.console) {
      const color = this.getColor(level);
      // remove trailing newline for console output
      const output = formatted.trim();
      if (color) {
        console.log(`${color}${output}\x1b[0m`);
      } else {
        console.log(output);
      }
    }
  }

  private getColor(level: LogLevel): string {
    switch (level) {
      case 'trace': return '\x1b[90m';  // gray
      case 'debug': return '\x1b[36m';  // cyan
      case 'info': return '';            // no color for info
      case 'warn': return '\x1b[33m';   // yellow
      case 'error': return '\x1b[31m';  // red
      case 'fatal': return '\x1b[35m';  // magenta
      default: return '';
    }
  }

  trace(message: string, data?: any) {
    this.writeLog('trace', message, data);
  }

  debug(message: string, data?: any) {
    this.writeLog('debug', message, data);
  }

  info(message: string, data?: any) {
    this.writeLog('info', message, data);
  }

  warn(message: string, data?: any) {
    this.writeLog('warn', message, data);
  }

  error(message: string, data?: any) {
    this.writeLog('error', message, data);
  }

  fatal(message: string, data?: any) {
    this.writeLog('fatal', message, data);
  }

  child(options: { domain?: string }): FileLogger {
    const child = Object.create(this);
    child.domain = options.domain;
    return child;
  }

  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    if (this.errorStream) {
      this.errorStream.end();
      this.errorStream = null;
    }
  }
}

// singleton logger
let logger: FileLogger;

export function getLogger(filePath?: string): FileLogger {
  if (!logger) {
    logger = new FileLogger();
  }
  
  if (!filePath) {
    return logger;
  }
  
  // extract basename without extension
  const basename = path.basename(filePath, path.extname(filePath));
  
  return logger.child({ domain: basename });
}

// handle uncaught errors
process.on('uncaughtException', (error) => {
  const log = getLogger();
  log.fatal('uncaught exception', error);
  log.close();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const log = getLogger();
  log.error('unhandled promise rejection', reason);
});

export default getLogger;