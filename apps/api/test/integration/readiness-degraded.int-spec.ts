import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap.js';
import { httpServer } from '../support/http.js';
import type { ReadinessResponse } from '../../src/modules/health/health.contract.js';

/**
 * Proves readiness genuinely fails when a dependency is missing (§44).
 *
 * A readiness probe that cannot return anything but 200 is worse than no probe, so
 * these tests point the application at real, closed TCP ports rather than mocking
 * the clients. Port 1 is reserved and never accepts connections.
 */
const UNREACHABLE_POSTGRES = 'postgresql://trilha:trilha@127.0.0.1:1/trilha';
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';

describe('Readiness with a dependency unavailable', () => {
  const originalDatabaseUrl = process.env['DATABASE_URL'];
  const originalRedisUrl = process.env['REDIS_URL'];
  let app: INestApplication | undefined;

  afterEach(async () => {
    process.env['DATABASE_URL'] = originalDatabaseUrl;
    process.env['REDIS_URL'] = originalRedisUrl;
    await app?.close();
    app = undefined;
  });

  describe('Redis unavailable', () => {
    it('still starts, but reports not ready with 503', async () => {
      process.env['REDIS_URL'] = UNREACHABLE_REDIS;
      process.env['REDIS_CONNECT_TIMEOUT_MS'] = '500';
      process.env['REDIS_COMMAND_TIMEOUT_MS'] = '500';

      /* Redis is not a source of truth, so losing it degrades the service rather
         than preventing boot (constitution §Architecture). */
      app = await createApp();
      await app.init();

      const response = await request(httpServer(app)).get('/api/v1/ready').expect(503);
      const body = response.body as ReadinessResponse;

      expect(body.status).toBe('not_ready');
      expect(body.dependencies['redis']?.status).toBe('down');
      /* PostgreSQL is untouched and must still report healthy. */
      expect(body.dependencies['postgres']?.status).toBe('up');

      delete process.env['REDIS_CONNECT_TIMEOUT_MS'];
      delete process.env['REDIS_COMMAND_TIMEOUT_MS'];
    });

    it('keeps liveness green while readiness is red', async () => {
      process.env['REDIS_URL'] = UNREACHABLE_REDIS;
      process.env['REDIS_CONNECT_TIMEOUT_MS'] = '500';
      process.env['REDIS_COMMAND_TIMEOUT_MS'] = '500';

      app = await createApp();
      await app.init();

      /* An orchestrator must not restart a process that is merely degraded. */
      await request(httpServer(app)).get('/api/v1/health').expect(200);
      await request(httpServer(app)).get('/api/v1/ready').expect(503);

      delete process.env['REDIS_CONNECT_TIMEOUT_MS'];
      delete process.env['REDIS_COMMAND_TIMEOUT_MS'];
    });

    it('does not leak the Redis URL in the failure reason', async () => {
      process.env['REDIS_URL'] = 'redis://someuser:sup3rs3cret@127.0.0.1:1';
      process.env['REDIS_CONNECT_TIMEOUT_MS'] = '500';
      process.env['REDIS_COMMAND_TIMEOUT_MS'] = '500';

      app = await createApp();
      await app.init();

      const response = await request(httpServer(app)).get('/api/v1/ready').expect(503);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('sup3rs3cret');
      expect(serialised).not.toContain('someuser');

      delete process.env['REDIS_CONNECT_TIMEOUT_MS'];
      delete process.env['REDIS_COMMAND_TIMEOUT_MS'];
    });
  });

  describe('PostgreSQL unavailable', () => {
    it('refuses to start at all', async () => {
      process.env['DATABASE_URL'] = UNREACHABLE_POSTGRES;
      process.env['DATABASE_CONNECT_TIMEOUT_MS'] = '500';

      /* PostgreSQL is the transactional source of truth: a process that cannot
         reach it must fail fast rather than serve traffic it cannot honour.
         `onModuleInit` runs during init(), which is where the connection is proven. */
      const failing = await createApp();
      await expect(failing.init()).rejects.toThrow();
      await failing.close().catch(() => undefined);

      delete process.env['DATABASE_CONNECT_TIMEOUT_MS'];
    });
  });
});
