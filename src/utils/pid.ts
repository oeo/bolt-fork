import fs from 'node:fs';

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

function processStart(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    const result = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', pid.toString()]);
    return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
  }
}

export function currentProcessIdentity(): ProcessIdentity {
  const startedAt = processStart(process.pid);
  if (!startedAt) throw new Error('cannot determine node process start time');
  return { pid: process.pid, startedAt };
}

export function processIdentityIsRunning(identity: ProcessIdentity): boolean {
  return Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
    typeof identity.startedAt === 'string' && processStart(identity.pid) === identity.startedAt;
}
