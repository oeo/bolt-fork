export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

class ConsoleLogger {
  constructor(private readonly domain = 'main') {}

  trace(message: string, data?: unknown): void { this.write('trace', message, data); }
  debug(message: string, data?: unknown): void { this.write('debug', message, data); }
  info(message: string, data?: unknown): void { this.write('info', message, data); }
  warn(message: string, data?: unknown): void { this.write('warn', message, data); }
  error(message: string, data?: unknown): void { this.write('error', message, data); }
  fatal(message: string, data?: unknown): void { this.write('fatal', message, data); }

  child(options: { domain?: string }): ConsoleLogger {
    return new ConsoleLogger(options.domain || this.domain);
  }

  close(): void {}

  private write(level: LogLevel, message: string, data?: unknown): void {
    const configured = process.env.LOG_LEVEL as LogLevel | undefined;
    const threshold = configured && configured in LEVELS ? configured : 'info';
    if (LEVELS[level] < LEVELS[threshold]) return;
    const output = `${new Date().toISOString()} ${level.toUpperCase()} [${this.domain}] ${message}${format(data)}`;
    if (level === 'error' || level === 'fatal') console.error(output);
    else if (level === 'warn') console.warn(output);
    else console.log(output);
  }
}

const root = new ConsoleLogger();

export function getLogger(filePath?: string): ConsoleLogger {
  if (!filePath) return root;
  const file = filePath.split(/[\\/]/).at(-1) || filePath;
  return root.child({ domain: file.replace(/\.[^.]+$/, '') });
}

function format(data: unknown): string {
  if (data === undefined) return '';
  if (data instanceof Error) return ` ${data.stack || data.message}`;
  if (typeof data !== 'object') return ` ${String(data)}`;
  try {
    return ` ${JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? value.toString() : value)}`;
  } catch {
    return ' [circular]';
  }
}

export default getLogger;
