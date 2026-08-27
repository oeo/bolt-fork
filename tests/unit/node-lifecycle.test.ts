import { describe, expect, it } from 'bun:test';
import { BoltIPFSNode } from '../../src/index';

function node(): BoltIPFSNode {
  return new BoltIPFSNode({
    apiPort: 7333,
    apiHost: '127.0.0.1',
    metricsPort: 7336,
    metricsHost: '127.0.0.1',
    role: 'full',
    dataDir: '/tmp/unused-bolt-lifecycle',
    storageType: 'memory',
  });
}

describe('node lifecycle', () => {
  it('unwinds partial start in reverse order before running', async () => {
    const events: string[] = [];
    const instance = node() as any;
    instance.networkOrchestrator = {
      start: async () => events.push('network:start'),
      stop: async () => events.push('network:stop'),
    };
    instance.api = {
      start: async () => { events.push('api:start'); throw new Error('injected api failure'); },
      stop: async () => events.push('api:stop'),
    };
    instance.mempool = { shutdown: async () => events.push('mempool:stop') };
    instance.storage = { close: async () => events.push('storage:stop') };

    await expect(instance.start()).rejects.toThrow('injected api failure');

    expect(events).toEqual([
      'network:start', 'api:start', 'api:stop', 'network:stop', 'mempool:stop', 'storage:stop'
    ]);
    await instance.stop();
  });

  it('stops partial initialization once and removes owned process listeners', async () => {
    const instance = node() as any;
    let closes = 0;
    instance.storage = { close: async () => { closes++; } };

    await Promise.all([instance.stop(), instance.stop()]);
    await instance.stop();

    expect(closes).toBe(1);
    expect(instance.signalHandlers.size).toBe(0);
  });

  it('continues cleanup after a resource stop fails', async () => {
    const instance = node() as any;
    let storageClosed = false;
    instance.api = { stop: async () => { throw new Error('injected stop failure'); } };
    instance.storage = { close: async () => { storageClosed = true; } };

    await expect(instance.stop()).rejects.toThrow('node shutdown failed');

    expect(storageClosed).toBe(true);
    expect(instance.signalHandlers.size).toBe(0);
  });
});
