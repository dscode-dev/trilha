import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { RedisService } from '../../src/infrastructure/cache/redis.service.js';
import { httpServer } from './http.js';

/** Password satisfying the policy, reused so tests read consistently. */
export const VALID_PASSWORD = 'a quiet trail through pine';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface RegisteredAccount {
  email: string;
  username: string;
  displayName: string;
  password: string;
  tokens: AuthTokens;
}

/**
 * Fresh identity values for one test.
 *
 * Unique per call so suites can run repeatedly against a persistent development
 * database without colliding on the unique constraints they are meant to exercise.
 */
export function uniqueIdentity(): { email: string; username: string; displayName: string } {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  return {
    email: `test-${suffix}@trilha.test`,
    username: `test${suffix}`,
    displayName: 'Test Person',
  };
}

/**
 * Drops every rate-limit counter.
 *
 * Redis is shared with anything else pointed at the same instance — another suite, a
 * developer's curl, the local API container — and its counters outlive a process.
 * Suites that authenticate repeatedly clear them first so a neighbour's traffic
 * cannot throttle them into a spurious failure.
 */
export async function clearRateLimits(app: INestApplication): Promise<void> {
  const redis = app.get(RedisService).connection;
  const keys = await redis.keys('ratelimit:*');
  if (keys.length > 0) await redis.del(...keys);
}

/** Registers an account through the real HTTP surface — no direct inserts. */
export async function registerAccount(
  app: INestApplication,
  overrides: Partial<{
    email: string;
    username: string;
    displayName: string;
    password: string;
  }> = {},
): Promise<RegisteredAccount> {
  const identity = uniqueIdentity();
  const payload = {
    email: overrides.email ?? identity.email,
    username: overrides.username ?? identity.username,
    displayName: overrides.displayName ?? identity.displayName,
    password: overrides.password ?? VALID_PASSWORD,
  };

  const response = await request(httpServer(app))
    .post('/api/v1/auth/register')
    .send(payload)
    .expect(201);

  return { ...payload, tokens: response.body as AuthTokens };
}

export function authHeader(tokens: Pick<AuthTokens, 'accessToken'>): [string, string] {
  return ['Authorization', `Bearer ${tokens.accessToken}`];
}

/**
 * supertest types `response.body` as `any`, which would silently switch off type
 * checking in exactly the assertions that guard the auth contract. Narrowing at the
 * boundary keeps the tests honest.
 */
export function tokensOf(response: { body: unknown }): AuthTokens {
  return response.body as AuthTokens;
}

export interface MeBody {
  id: string;
  email: string;
  status: string;
  profile: {
    username: string;
    displayName: string;
    avatarUrl: string | null;
    bio: string | null;
  };
}

export function meOf(response: { body: unknown }): MeBody {
  return response.body as MeBody;
}
