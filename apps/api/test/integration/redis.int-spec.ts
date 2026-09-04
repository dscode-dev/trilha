import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';

/**
 * Proves Redis connectivity and lifecycle against a real server (§8, §24).
 *
 * PR-00 introduces no domain caching, so these tests exercise the infrastructure
 * contract only: connect, round-trip, expire, and fail predictably when absent.
 */
describe('Redis integration', () => {
  let client: Redis;
  const keyPrefix = `trilha:int-test:${String(Date.now())}`;

  beforeAll(async () => {
    client = new Redis(process.env['REDIS_URL'] ?? '', { lazyConnect: true });
    await client.connect();
  });

  afterAll(async () => {
    const keys = await client.keys(`${keyPrefix}*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });

  it('answers PING', async () => {
    await expect(client.ping()).resolves.toBe('PONG');
  });

  it('reports a Redis major version the project supports', async () => {
    const info = await client.info('server');
    const version = /redis_version:(\d+)\./.exec(info)?.[1];
    expect(Number(version)).toBeGreaterThanOrEqual(7);
  });

  it('round-trips a value', async () => {
    await client.set(`${keyPrefix}:hello`, 'world');
    await expect(client.get(`${keyPrefix}:hello`)).resolves.toBe('world');
  });

  it('honours key expiry', async () => {
    await client.set(`${keyPrefix}:ttl`, 'x', 'EX', 60);
    const ttl = await client.ttl(`${keyPrefix}:ttl`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('returns null for a missing key instead of throwing', async () => {
    await expect(client.get(`${keyPrefix}:absent`)).resolves.toBeNull();
  });

  it('fails fast against an unreachable server rather than hanging', async () => {
    /* Port 1 is reserved and never listening — a genuine connection failure. */
    const unreachable = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      connectTimeout: 500,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });

    await expect(unreachable.connect()).rejects.toThrow();
    unreachable.disconnect();
  });
});
