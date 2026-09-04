import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap.js';
import { httpServer } from '../support/http.js';
import type {
  HealthResponse,
  ReadinessResponse,
} from '../../src/modules/health/health.contract.js';
import type { ErrorResponse } from '../../src/common/errors/error-response.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';

/**
 * End-to-end platform behaviour with every dependency genuinely available (§10, §44).
 *
 * The application under test is built by the same `createApp()` that `main.ts` uses,
 * so there is no test-only wiring that could pass while production wiring is broken.
 */
describe('Platform endpoints (dependencies available)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/health', () => {
    it('reports the process as alive', async () => {
      const response = await request(httpServer(app)).get('/api/v1/health').expect(200);
      const body = response.body as HealthResponse;

      expect(body).toMatchObject({ status: 'ok', service: 'trilha-api' });
      expect(body.uptimeSeconds).toBeGreaterThan(0);
      expect(Date.parse(body.timestamp)).not.toBeNaN();
    });

    it('returns a UTC timestamp (constitution §Engineering: UTC internally)', async () => {
      const response = await request(httpServer(app)).get('/api/v1/health').expect(200);
      expect((response.body as HealthResponse).timestamp).toMatch(/Z$/);
    });
  });

  describe('GET /api/v1/ready', () => {
    it('reports ready with every dependency up', async () => {
      const response = await request(httpServer(app)).get('/api/v1/ready').expect(200);
      const body = response.body as ReadinessResponse;

      expect(body.status).toBe('ready');
      expect(body.dependencies['postgres']?.status).toBe('up');
      expect(body.dependencies['redis']?.status).toBe('up');
    });

    it('measures each dependency probe', async () => {
      const response = await request(httpServer(app)).get('/api/v1/ready').expect(200);
      const body = response.body as ReadinessResponse;

      expect(body.dependencies['postgres']?.durationMs).toBeGreaterThanOrEqual(0);
      expect(body.dependencies['redis']?.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('request correlation (§12)', () => {
    it('generates a request id when the client sends none', async () => {
      const response = await request(httpServer(app)).get('/api/v1/health').expect(200);

      expect(response.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('echoes a well-formed inbound request id', async () => {
      const response = await request(httpServer(app))
        .get('/api/v1/health')
        .set('x-request-id', 'trace-abc-123')
        .expect(200);

      expect(response.headers['x-request-id']).toBe('trace-abc-123');
    });

    it('replaces a hostile request id instead of reflecting it', async () => {
      const response = await request(httpServer(app))
        .get('/api/v1/health')
        .set('x-request-id', 'bad id with spaces')
        .expect(200);

      expect(response.headers['x-request-id']).not.toBe('bad id with spaces');
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('issues a distinct id per request', async () => {
      const [first, second] = await Promise.all([
        request(httpServer(app)).get('/api/v1/health'),
        request(httpServer(app)).get('/api/v1/health'),
      ]);

      expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
    });
  });

  describe('error contract (§11)', () => {
    it('returns the standard envelope for an unknown route', async () => {
      const response = await request(httpServer(app)).get('/api/v1/does-not-exist').expect(404);

      const { error } = response.body as ErrorResponse;

      expect(error.code).toBe('NOT_FOUND');
      expect(typeof error.message).toBe('string');
      expect(typeof error.requestId).toBe('string');
      expect(error.details).toEqual({ method: 'GET', path: '/api/v1/does-not-exist' });
    });

    it('carries the caller request id into the error body', async () => {
      const response = await request(httpServer(app))
        .get('/api/v1/nope')
        .set('x-request-id', 'err-trace-1')
        .expect(404);

      expect((response.body as ErrorResponse).error.requestId).toBe('err-trace-1');
    });

    it('never leaks a stack trace or internal path', async () => {
      const response = await request(httpServer(app)).get('/api/v1/nope').expect(404);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toMatch(/at .*\(/);
      expect(serialised).not.toContain('node_modules');
      expect(serialised).not.toContain('/Users/');
      expect((response.body as ErrorResponse).error).not.toHaveProperty('stack');
    });
  });

  describe('security baseline (§30)', () => {
    it('applies helmet security headers', async () => {
      const response = await request(httpServer(app)).get('/api/v1/health').expect(200);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBeDefined();
    });

    it('does not advertise the server framework', async () => {
      const response = await request(httpServer(app)).get('/api/v1/health').expect(200);
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('rejects a body larger than the configured limit', async () => {
      const response = await request(httpServer(app))
        .post('/api/v1/health')
        .set('Content-Type', 'application/json')
        .send({ blob: 'x'.repeat(2 * 1024 * 1024) });

      expect(response.status).toBe(413);
      expect((response.body as ErrorResponse).error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  it('serves only the versioned prefix', async () => {
    await request(httpServer(app)).get('/health').expect(404);
  });
});
