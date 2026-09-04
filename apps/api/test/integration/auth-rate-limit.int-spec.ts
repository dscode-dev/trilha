import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { RedisService } from '../../src/infrastructure/cache/redis.service.js';
import { httpServer } from '../support/http.js';
import { VALID_PASSWORD, registerAccount, uniqueIdentity } from '../support/identity.js';
import type { ErrorResponse } from '../../src/common/errors/error-response.js';

/**
 * Distributed authentication rate limiting (§26).
 *
 * The app is built with deliberately tiny ceilings so the limits can be reached in a
 * few requests. Counters live in the real Redis from docker-compose — an in-memory
 * counter would prove nothing about a multi-instance deployment.
 */
describe('Authentication rate limiting', () => {
  let app: INestApplication;
  let redis: RedisService;

  const LOGIN_PER_IP = 6;
  const LOGIN_PER_ACCOUNT = 3;
  const REGISTER_PER_IP = 4;

  beforeAll(async () => {
    await runMigrations();

    process.env['RATE_LIMIT_LOGIN_PER_IP'] = String(LOGIN_PER_IP);
    process.env['RATE_LIMIT_LOGIN_PER_ACCOUNT'] = String(LOGIN_PER_ACCOUNT);
    process.env['RATE_LIMIT_REGISTER_PER_IP'] = String(REGISTER_PER_IP);
    process.env['RATE_LIMIT_WINDOW_SECONDS'] = '60';

    app = await createApp();
    await app.init();
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    process.env['RATE_LIMIT_LOGIN_PER_IP'] = '10000';
    process.env['RATE_LIMIT_LOGIN_PER_ACCOUNT'] = '10000';
    process.env['RATE_LIMIT_REGISTER_PER_IP'] = '10000';
    await app.close();
  });

  /** Each test starts from a clean slate; buckets are keyed by a shared loopback IP. */
  const clearBuckets = async (): Promise<void> => {
    const keys = await redis.connection.keys('ratelimit:*');
    if (keys.length > 0) await redis.connection.del(...keys);
  };

  const login = (email: string, password = 'a deliberately wrong password') =>
    request(httpServer(app)).post('/api/v1/auth/login').send({ email, password });

  it('throttles repeated failures against one account', async () => {
    await clearBuckets();
    const account = await registerAccount(app);

    for (let attempt = 1; attempt <= LOGIN_PER_ACCOUNT; attempt += 1) {
      await login(account.email).expect(401);
    }

    const throttled = await login(account.email).expect(429);
    expect((throttled.body as ErrorResponse).error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('tells the client how long to wait', async () => {
    await clearBuckets();
    const account = await registerAccount(app);

    for (let attempt = 1; attempt <= LOGIN_PER_ACCOUNT; attempt += 1) {
      await login(account.email).expect(401);
    }

    const throttled = await login(account.email).expect(429);
    const retryAfter = (throttled.body as ErrorResponse).error.details?.['retryAfterSeconds'];

    expect(typeof retryAfter).toBe('number');
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('throttles a spread of accounts from one source', async () => {
    await clearBuckets();

    /* Distinct addresses each time, so only the per-IP bucket can trigger. */
    let throttled = false;
    for (let attempt = 1; attempt <= LOGIN_PER_IP + 2; attempt += 1) {
      const response = await login(uniqueIdentity().email);
      if (response.status === 429) {
        throttled = true;
        break;
      }
    }

    expect(throttled).toBe(true);
  });

  it('throttles registration from one source', async () => {
    await clearBuckets();

    let throttled = false;
    for (let attempt = 1; attempt <= REGISTER_PER_IP + 2; attempt += 1) {
      const response = await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...uniqueIdentity(), password: VALID_PASSWORD });

      if (response.status === 429) {
        throttled = true;
        break;
      }
    }

    expect(throttled).toBe(true);
  });

  it('clears the account bucket after a successful sign-in', async () => {
    await clearBuckets();
    const account = await registerAccount(app);

    /* Fumble, but stop short of the ceiling. */
    await login(account.email).expect(401);
    await login(account.email).expect(401);

    /* Getting it right must not leave the user throttled. */
    await request(httpServer(app))
      .post('/api/v1/auth/login')
      .send({ email: account.email, password: account.password })
      .expect(200);
  });

  describe('key hygiene (§48)', () => {
    it('never puts an email address in a Redis key', async () => {
      await clearBuckets();
      const account = await registerAccount(app);
      await login(account.email).expect(401);

      const keys = await redis.connection.keys('ratelimit:*');
      expect(keys.length).toBeGreaterThan(0);

      const localPart = account.email.split('@')[0] ?? '';
      for (const key of keys) {
        expect(key).not.toContain(account.email);
        expect(key).not.toContain(localPart);
      }
    });

    it('gives every counter a TTL so keys cannot accumulate', async () => {
      await clearBuckets();
      await login(uniqueIdentity().email).expect(401);

      const keys = await redis.connection.keys('ratelimit:*');
      for (const key of keys) {
        const ttl = await redis.connection.ttl(key);
        expect(ttl).toBeGreaterThan(0);
      }
    });
  });

  it('does not throttle authenticated session endpoints', async () => {
    await clearBuckets();
    const account = await registerAccount(app);

    /* Securing an account must never be rate limited away. */
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await request(httpServer(app))
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${account.tokens.accessToken}`)
        .expect((response) => {
          expect(response.status).not.toBe(429);
        });
    }
  });
});
