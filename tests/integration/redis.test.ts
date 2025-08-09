import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import Redis from 'ioredis';

describe('Redis Connection', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis({
      host: 'localhost',
      port: 7337,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 100, 2000);
      }
    });
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('should connect to Redis', async () => {
    const pong = await redis.ping();
    expect(pong).toBe('PONG');
  });

  it('should write and read data', async () => {
    await redis.set('test:key', 'test-value');
    const value = await redis.get('test:key');
    expect(value).toBe('test-value');
    await redis.del('test:key');
  });

  it('should handle JSON data', async () => {
    const testData = { foo: 'bar', count: 42 };
    await redis.set('test:json', JSON.stringify(testData));
    const retrieved = await redis.get('test:json');
    expect(JSON.parse(retrieved!)).toEqual(testData);
    await redis.del('test:json');
  });

  it('should support atomic operations', async () => {
    await redis.set('test:counter', '0');
    const result = await redis.incr('test:counter');
    expect(result).toBe(1);
    await redis.del('test:counter');
  });
});