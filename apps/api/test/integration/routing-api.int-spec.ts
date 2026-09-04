import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { ROUTING_PROVIDER } from '../../src/modules/routing/domain/routing-provider.js';
import {
  RouteNotFoundError,
  RoutingProviderRateLimitedError,
  RoutingProviderTimeoutError,
  RoutingProviderUnavailableError,
} from '../../src/modules/routing/domain/routing-errors.js';
import { httpServer } from '../support/http.js';
import { clearRateLimits, registerAccount, type AuthTokens } from '../support/identity.js';
import { FakeRoutingProvider } from '../support/routing.js';
import type { ErrorResponse } from '../../src/common/errors/error-response.js';

/**
 * The routing endpoint end to end (§54).
 *
 * The provider port is replaced with a deterministic implementation, so these tests
 * exercise validation, normalisation, corridor generation, auth and error mapping
 * without depending on an upstream credential — which this environment does not have.
 * PostGIS is real.
 */
describe('POST /routes/calculate', () => {
  let app: INestApplication;
  let provider: FakeRoutingProvider;
  let tokens: AuthTokens;

  const RECIFE = { latitude: -8.0631, longitude: -34.8711 };
  const JOAO_PESSOA = { latitude: -7.115, longitude: -34.8631 };

  beforeAll(async () => {
    await runMigrations();
    provider = new FakeRoutingProvider();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(provider)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    await clearRateLimits(app);
    tokens = (await registerAccount(app)).tokens;
  }, 60_000);

  afterEach(() => {
    provider.failure = null;
    provider.calls = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  const calculate = (body: unknown, auth = true) => {
    const req = request(httpServer(app)).post('/api/v1/routes/calculate');
    if (auth) req.set('Authorization', `Bearer ${tokens.accessToken}`);
    return req.send(body as object);
  };

  describe('success', () => {
    it('returns a normalised route', async () => {
      const response = await calculate({ origin: RECIFE, destination: JOAO_PESSOA }).expect(200);
      const body = response.body as Record<string, unknown>;

      expect(body['distanceMeters']).toBe(105_060);
      expect(body['durationSeconds']).toBe(6_480);
      expect((body['geometry'] as { type: string }).type).toBe('LineString');
      expect(body['legs']).toHaveLength(1);
    });

    it('computes bounds from the geometry, covering every vertex (§17)', async () => {
      const response = await calculate({ origin: RECIFE, destination: JOAO_PESSOA }).expect(200);
      const bounds = (response.body as { bounds: Record<string, number> }).bounds;

      expect(bounds['north']).toBeCloseTo(-7.115, 3);
      expect(bounds['south']).toBeCloseTo(-8.0631, 3);
      expect(bounds['west']).toBeCloseTo(-34.8711, 3);
    });

    it('omits the corridor unless it is asked for (§47)', async () => {
      const response = await calculate({ origin: RECIFE, destination: JOAO_PESSOA }).expect(200);

      expect((response.body as { corridor: unknown }).corridor).toBeNull();
    });

    it('returns a real PostGIS corridor when requested', async () => {
      const response = await calculate({
        origin: RECIFE,
        destination: JOAO_PESSOA,
        includeCorridor: true,
      }).expect(200);

      const corridor = (
        response.body as {
          corridor: { widthMeters: number; geometry: { type: string } };
        }
      ).corridor;

      expect(corridor.widthMeters).toBe(5_000);
      expect(['Polygon', 'MultiPolygon']).toContain(corridor.geometry.type);
    });

    it('clamps a corridor width above the configured maximum', async () => {
      const response = await calculate({
        origin: RECIFE,
        destination: JOAO_PESSOA,
        includeCorridor: true,
        corridorWidthMeters: 50_000,
      }).expect(200);

      expect((response.body as { corridor: { widthMeters: number } }).corridor.widthMeters).toBe(
        20_000,
      );
    });

    it('honours a narrower corridor width', async () => {
      const response = await calculate({
        origin: RECIFE,
        destination: JOAO_PESSOA,
        includeCorridor: true,
        corridorWidthMeters: 2_000,
      }).expect(200);

      expect((response.body as { corridor: { widthMeters: number } }).corridor.widthMeters).toBe(
        2_000,
      );
    });

    it('echoes optional placeIds without requiring them (§7)', async () => {
      const placeId = '01a06cc8-9b3a-7ba0-879e-f01610559f9c';
      const response = await calculate({
        origin: { ...RECIFE, placeId },
        destination: JOAO_PESSOA,
      }).expect(200);

      const body = response.body as {
        origin: { placeId?: string };
        destination: { placeId?: string };
      };
      expect(body.origin.placeId).toBe(placeId);
      expect(body.destination.placeId).toBeUndefined();
    });

    it('asks the provider for driving only (§29)', async () => {
      await calculate({ origin: RECIFE, destination: JOAO_PESSOA }).expect(200);

      expect(provider.requests.at(-1)?.profile).toBe('DRIVING');
    });

    it('never leaks provider internals into the response (§64)', async () => {
      const response = await calculate({ origin: RECIFE, destination: JOAO_PESSOA }).expect(200);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('mapbox');
      expect(serialised).not.toContain('access_token');
      expect(serialised).not.toContain('provider');
    });
  });

  describe('request validation (§8, §55, §56)', () => {
    it.each([
      ['a missing origin', { destination: JOAO_PESSOA }],
      ['a missing destination', { origin: RECIFE }],
      [
        'latitude out of range',
        { origin: { latitude: 91, longitude: 0 }, destination: JOAO_PESSOA },
      ],
      ['longitude out of range', { origin: RECIFE, destination: { latitude: 0, longitude: 181 } }],
      [
        'an empty-string latitude',
        { origin: { latitude: '', longitude: -34.8 }, destination: JOAO_PESSOA },
      ],
      ['a null longitude', { origin: { latitude: -8, longitude: null }, destination: JOAO_PESSOA }],
      [
        'a non-numeric coordinate',
        { origin: { latitude: 'abc', longitude: -34.8 }, destination: JOAO_PESSOA },
      ],
    ])('rejects %s', async (_name, body) => {
      const response = await calculate(body).expect(400);
      expect((response.body as ErrorResponse).error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects identical origin and destination without calling the provider', async () => {
      const response = await calculate({ origin: RECIFE, destination: RECIFE }).expect(400);

      expect((response.body as ErrorResponse).error.code).toBe('INVALID_ROUTE_REQUEST');
      /* A metered request must not be spent on a route of zero length. */
      expect(provider.calls).toBe(0);
    });

    it('rejects points inside the minimum separation', async () => {
      const almostThere = { latitude: RECIFE.latitude + 0.0001, longitude: RECIFE.longitude };

      await calculate({ origin: RECIFE, destination: almostThere }).expect(400);
      expect(provider.calls).toBe(0);
    });

    it('rejects implausibly distant endpoints without calling the provider', async () => {
      const antipode = { latitude: 8.0631, longitude: 145.1289 };

      const response = await calculate({ origin: RECIFE, destination: antipode }).expect(400);

      expect((response.body as ErrorResponse).error.code).toBe('INVALID_ROUTE_REQUEST');
      expect(provider.calls).toBe(0);
    });

    it('accepts a short but genuine journey', async () => {
      const nearby = { latitude: RECIFE.latitude + 0.002, longitude: RECIFE.longitude };

      await calculate({ origin: RECIFE, destination: nearby }).expect(200);
      expect(provider.calls).toBe(1);
    });
  });

  describe('authorization (§26)', () => {
    it('refuses an unauthenticated request', async () => {
      const response = await calculate({ origin: RECIFE, destination: JOAO_PESSOA }, false).expect(
        401,
      );

      /* Routing spends money at a third party, so an open endpoint would be a free
         proxy to a metered API. */
      expect((response.body as ErrorResponse).error.code).toBe('INVALID_TOKEN');
      expect(provider.calls).toBe(0);
    });

    it('refuses an invalid token', async () => {
      await request(httpServer(app))
        .post('/api/v1/routes/calculate')
        .set('Authorization', 'Bearer not-a-real-token')
        .send({ origin: RECIFE, destination: JOAO_PESSOA })
        .expect(401);

      expect(provider.calls).toBe(0);
    });
  });

  describe('provider failures, normalised (§22)', () => {
    it.each([
      ['no route', new RouteNotFoundError(), 422, 'ROUTE_NOT_FOUND'],
      ['a timeout', new RoutingProviderTimeoutError(), 504, 'PROVIDER_TIMEOUT'],
      ['an outage', new RoutingProviderUnavailableError(), 502, 'PROVIDER_UNAVAILABLE'],
      ['upstream throttling', new RoutingProviderRateLimitedError(), 503, 'PROVIDER_RATE_LIMITED'],
    ])('maps %s to %i', async (_name, failure, status, code) => {
      provider.failure = failure;

      const response = await calculate({ origin: RECIFE, destination: JOAO_PESSOA }).expect(status);
      expect((response.body as ErrorResponse).error.code).toBe(code);
    });

    it('does not leak an upstream message to the client', async () => {
      provider.failure = new RoutingProviderUnavailableError(
        new Error('https://api.mapbox.com/directions/v5?access_token=pk.secret'),
      );

      const response = await calculate({ origin: RECIFE, destination: JOAO_PESSOA }).expect(502);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('pk.secret');
      expect(serialised).not.toContain('mapbox.com');
    });

    it('masks an unexpected provider crash as a generic failure', async () => {
      provider.failure = new Error('connect ECONNREFUSED 10.0.0.4:443');

      const response = await calculate({ origin: RECIFE, destination: JOAO_PESSOA }).expect(500);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('10.0.0.4');
      expect((response.body as ErrorResponse).error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('rate limiting (§27)', () => {
    it('throttles a burst of route requests', async () => {
      /* Deliberately tight for this test only; routing costs money per call. */
      const previous = process.env['RATE_LIMIT_ROUTING_PER_USER'];
      process.env['RATE_LIMIT_ROUTING_PER_USER'] = '3';

      const throttled = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ROUTING_PROVIDER)
        .useValue(provider)
        .compile();

      const limitedApp = throttled.createNestApplication();
      limitedApp.setGlobalPrefix('api/v1');
      await limitedApp.init();
      await clearRateLimits(limitedApp);

      const session = (await registerAccount(limitedApp)).tokens;
      const send = () =>
        request(httpServer(limitedApp))
          .post('/api/v1/routes/calculate')
          .set('Authorization', `Bearer ${session.accessToken}`)
          .send({ origin: RECIFE, destination: JOAO_PESSOA });

      let sawThrottle = false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await send();
        if (response.status === 429) {
          sawThrottle = true;
          expect((response.body as ErrorResponse).error.code).toBe('TOO_MANY_REQUESTS');
          expect((response.body as ErrorResponse).error.details?.['retryAfterSeconds']).toBeTypeOf(
            'number',
          );
          break;
        }
      }

      await limitedApp.close();
      if (previous === undefined) {
        delete process.env['RATE_LIMIT_ROUTING_PER_USER'];
      } else {
        process.env['RATE_LIMIT_ROUTING_PER_USER'] = previous;
      }

      expect(sawThrottle).toBe(true);
    }, 60_000);
  });

  describe('privacy (§58)', () => {
    it('does not persist the journey', async () => {
      await calculate({ origin: RECIFE, destination: JOAO_PESSOA }).expect(200);

      /* PR-03 adds no table: a route is a computation, not a record (§48, §73). */
      const { DatabaseService } =
        await import('../../src/infrastructure/database/database.service.js');
      const { sql } = await import('drizzle-orm');
      const database = app.get(DatabaseService);

      const tables = await database.db.execute<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '%route%'`,
      );

      expect(tables.rows).toEqual([]);
    });
  });
});
