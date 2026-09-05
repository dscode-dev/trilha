import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { AppModule } from '../../src/app.module.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { ROUTING_PROVIDER } from '../../src/modules/routing/domain/routing-provider.js';
import { ROUTE_COST_PROVIDER } from '../../src/modules/discovery/domain/route-cost-provider.js';
import {
  RouteNotFoundError,
  RoutingProviderTimeoutError,
  RoutingProviderUnavailableError,
} from '../../src/modules/routing/domain/routing-errors.js';
import { httpServer } from '../support/http.js';
import { clearRateLimits, registerAccount, type AuthTokens } from '../support/identity.js';
import { FakeRoutingProvider } from '../support/routing.js';
import { FakeRouteCostProvider } from '../support/discovery.js';
import type { ErrorResponse } from '../../src/common/errors/error-response.js';

/**
 * The discovery endpoint end to end (§74, §76).
 *
 * Both provider ports are replaced with deterministic implementations, so the whole
 * pipeline — route, spatial retrieval, detour, ranking, response — is exercised
 * without an upstream credential, which this environment does not have. **PostGIS is
 * real**, so the spatial stage is the production query against production indexes.
 */
describe('POST /discovery/routes', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let routing: FakeRoutingProvider;
  let costs: FakeRouteCostProvider;
  let tokens: AuthTokens;

  const RECIFE = { latitude: -8.0631, longitude: -34.8711 };
  const JOAO_PESSOA = { latitude: -7.115, longitude: -34.8631 };

  const suite = `DiscApi-${Math.random().toString(36).slice(2, 8)}`;

  /** Places positioned along the fake provider's fixed BR-101 geometry. */
  const seeded: Record<string, { id: string; latitude: number; longitude: number }> = {};

  /** The account whose contributions the seeded Places are attributed to. */
  let contributorId: string;

  const seed = async (params: {
    key: string;
    latitude: number;
    longitude: number;
    categoryId?: string;
    status?: string;
  }): Promise<void> => {
    const result = await database.db.execute<{ id: string }>(sql`
      INSERT INTO places (name, category_id, location, provenance, status, created_by_user_id)
      VALUES (
        ${`${suite} ${params.key}`},
        ${params.categoryId ?? 'LANDMARK'},
        ST_SetSRID(ST_MakePoint(${params.longitude}, ${params.latitude}), 4326)::geography,
        /* Community-contributed, because the one community aspect of PR-04 is that
           Places created by people participate on equal terms (§87). */
        'COMMUNITY',
        ${params.status ?? 'ACTIVE'},
        ${contributorId}
      )
      RETURNING id
    `);

    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('seed failed');
    seeded[params.key] = { id, latitude: params.latitude, longitude: params.longitude };
  };

  beforeAll(async () => {
    await runMigrations();
    routing = new FakeRoutingProvider();
    costs = new FakeRouteCostProvider();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(routing)
      .overrideProvider(ROUTE_COST_PROVIDER)
      .useValue(costs)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    database = app.get(DatabaseService);
    await clearRateLimits(app);
    tokens = (await registerAccount(app)).tokens;

    const me = await request(httpServer(app))
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
    contributorId = (me.body as { id: string }).id;

    /* Three Places beside the route at ~25%, ~50% and ~75% of the journey, plus one
       that should never be eligible. */
    await seed({
      key: 'museum',
      latitude: -7.83,
      longitude: -34.845,
      categoryId: 'HISTORY_CULTURE',
    });
    await seed({ key: 'restaurant', latitude: -7.6, longitude: -34.835, categoryId: 'FOOD' });
    await seed({ key: 'viewpoint', latitude: -7.4, longitude: -34.845, categoryId: 'NATURE' });
    await seed({ key: 'archived', latitude: -7.5, longitude: -34.845, status: 'ARCHIVED' });

    /* Scripted so the ranking has a known answer: +6, +9 and +14 minutes. */
    costs.setDetour(place('museum'), 360);
    costs.setDetour(place('restaurant'), 540);
    costs.setDetour(place('viewpoint'), 840);
  }, 60_000);

  afterEach(async () => {
    routing.failure = null;
    costs.failure = null;
    costs.calls = 0;
    await clearRateLimits(app);
  });

  afterAll(async () => {
    await database.db.execute(sql`DELETE FROM places WHERE name LIKE ${`${suite}%`}`);
    await app.close();
  });

  /** A seeded Place, or a loud failure if the fixture is missing. */
  const place = (key: string): { id: string; latitude: number; longitude: number } => {
    const seededPlace = seeded[key];
    if (seededPlace === undefined) throw new Error(`No seeded place for ${key}`);
    return seededPlace;
  };

  const discover = (body: unknown, auth = true) => {
    const req = request(httpServer(app)).post('/api/v1/discovery/routes');
    if (auth) req.set('Authorization', `Bearer ${tokens.accessToken}`);
    return req.send(body as object);
  };

  const baseBody = { origin: RECIFE, destination: JOAO_PESSOA };

  /** Only this suite's Places, so other specs' data cannot change an assertion. */
  const mine = (body: Record<string, unknown>): { id: string; name: string }[] => {
    const candidates = body.candidates as { place: { id: string; name: string } }[];
    return candidates.map((c) => c.place).filter((p) => p.name.startsWith(suite));
  };

  describe('authentication (§41)', () => {
    it('rejects an anonymous request', async () => {
      const response = await discover(baseBody, false).expect(401);
      expect((response.body as ErrorResponse).error.code).toBe('INVALID_TOKEN');
    });

    it('spends nothing upstream when unauthenticated', async () => {
      await discover(baseBody, false).expect(401);

      /* An open discovery endpoint would be a free proxy to two metered APIs. */
      expect(routing.calls).toBe(0);
      expect(costs.calls).toBe(0);
    });

    it('accepts an authenticated request', async () => {
      await discover(baseBody).expect(200);
    });
  });

  describe('success (§40)', () => {
    it('returns the base route the candidates are measured against', async () => {
      const response = await discover(baseBody).expect(200);
      const body = response.body as Record<string, unknown>;

      expect(body.route).toEqual({ distanceMeters: 105_060, durationSeconds: 6_480 });
    });

    it('names the policy that produced the ranking', async () => {
      const response = await discover(baseBody).expect(200);
      expect((response.body as Record<string, unknown>).policyVersion).toBe('v1');
    });

    it('returns candidates drawn from real Places', async () => {
      const response = await discover(baseBody).expect(200);
      const ids = mine(response.body as Record<string, unknown>).map((p) => p.id);

      expect(ids).toContain(seeded.museum?.id);
      expect(ids).toContain(seeded.restaurant?.id);
      expect(ids).toContain(seeded.viewpoint?.id);
    });

    it('carries every documented field on a candidate', async () => {
      const response = await discover(baseBody).expect(200);
      const candidates = (response.body as Record<string, unknown>).candidates as Record<
        string,
        unknown
      >[];
      const candidate = candidates.find(
        (c) => (c.place as { id: string }).id === seeded.museum?.id,
      );

      expect(candidate).toMatchObject({
        distanceFromRouteMeters: expect.any(Number) as number,
        detourDistanceMeters: expect.any(Number) as number,
        detourDurationSeconds: 360,
        routeProgress: expect.any(Number) as number,
        relevanceScore: expect.any(Number) as number,
      });
      expect(candidate?.relevanceReasons).toBeInstanceOf(Array);
    });

    it('returns a compact Place, not a full detail record', async () => {
      const response = await discover(baseBody).expect(200);
      const candidates = (response.body as Record<string, unknown>).candidates as {
        place: Record<string, unknown>;
      }[];

      const place = candidates[0]?.place ?? {};
      expect(Object.keys(place).sort()).toEqual([
        'categoryId',
        'id',
        'latitude',
        'longitude',
        'name',
        'provenance',
      ]);
    });

    it('reports how the funnel narrowed', async () => {
      const response = await discover(baseBody).expect(200);
      const diagnostics = (response.body as Record<string, unknown>).diagnostics as {
        spatialCandidates: number;
        evaluatedCandidates: number;
        returnedCandidates: number;
      };

      /* The funnel only ever narrows: every stage sees at most what the one before
         it produced (§10). */
      expect(diagnostics.spatialCandidates).toBeGreaterThanOrEqual(3);
      expect(diagnostics.evaluatedCandidates).toBeLessThanOrEqual(diagnostics.spatialCandidates);
      expect(diagnostics.returnedCandidates).toBeLessThanOrEqual(diagnostics.evaluatedCandidates);
    });

    it('orders by relevance, best first', async () => {
      const response = await discover(baseBody).expect(200);
      const scores = (
        (response.body as Record<string, unknown>).candidates as {
          relevanceScore: number;
        }[]
      ).map((c) => c.relevanceScore);

      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    it('excludes a Place that is not ACTIVE', async () => {
      const response = await discover(baseBody).expect(200);
      const ids = mine(response.body as Record<string, unknown>).map((p) => p.id);

      expect(ids).not.toContain(seeded.archived?.id);
    });

    it('returns the same ranking for the same request (§38)', async () => {
      const first = await discover(baseBody).expect(200);
      const second = await discover(baseBody).expect(200);

      const idsOf = (body: unknown): string[] =>
        ((body as Record<string, unknown>).candidates as { place: { id: string } }[]).map(
          (c) => c.place.id,
        );

      expect(idsOf(second.body)).toEqual(idsOf(first.body));
    });
  });

  describe('filters (§22, §23)', () => {
    it('restricts candidates to the requested categories', async () => {
      const response = await discover({ ...baseBody, categories: ['FOOD'] }).expect(200);
      const ids = mine(response.body as Record<string, unknown>).map((p) => p.id);

      expect(ids).toContain(seeded.restaurant?.id);
      expect(ids).not.toContain(seeded.museum?.id);
    });

    it('accepts several categories', async () => {
      const response = await discover({
        ...baseBody,
        categories: ['FOOD', 'HISTORY_CULTURE'],
      }).expect(200);
      const ids = mine(response.body as Record<string, unknown>).map((p) => p.id);

      expect(ids).toContain(seeded.restaurant?.id);
      expect(ids).toContain(seeded.museum?.id);
      expect(ids).not.toContain(seeded.viewpoint?.id);
    });

    it('treats an omitted category list as every category', async () => {
      const response = await discover(baseBody).expect(200);
      expect(mine(response.body as Record<string, unknown>).length).toBeGreaterThanOrEqual(3);
    });

    it('honours a tighter detour ceiling', async () => {
      const response = await discover({ ...baseBody, maxDetourMinutes: 8 }).expect(200);
      const ids = mine(response.body as Record<string, unknown>).map((p) => p.id);

      /* museum +6 min stays; restaurant +9 min and viewpoint +14 min are over. */
      expect(ids).toContain(seeded.museum?.id);
      expect(ids).not.toContain(seeded.restaurant?.id);
      expect(ids).not.toContain(seeded.viewpoint?.id);
    });

    it('honours the requested limit', async () => {
      const response = await discover({ ...baseBody, limit: 1 }).expect(200);
      expect((response.body as Record<string, unknown>).candidates).toHaveLength(1);
    });

    it('narrows the corridor when asked', async () => {
      const wide = await discover({ ...baseBody, corridorWidthMeters: 20_000 }).expect(200);
      const narrow = await discover({ ...baseBody, corridorWidthMeters: 500 }).expect(200);

      expect(mine(narrow.body as Record<string, unknown>).length).toBeLessThanOrEqual(
        mine(wide.body as Record<string, unknown>).length,
      );
    });
  });

  describe('validation (§74, §82)', () => {
    it('rejects a missing origin', async () => {
      await discover({ destination: JOAO_PESSOA }).expect(400);
    });

    it('rejects an out-of-range coordinate', async () => {
      await discover({
        origin: { latitude: 91, longitude: -34.8 },
        destination: JOAO_PESSOA,
      }).expect(400);
    });

    it('rejects endpoints that are effectively the same point', async () => {
      const response = await discover({ origin: RECIFE, destination: RECIFE }).expect(400);
      expect((response.body as ErrorResponse).error.code).toBe('INVALID_ROUTE_REQUEST');
    });

    it('rejects a malformed category id', async () => {
      await discover({ ...baseBody, categories: ['food; DROP TABLE places'] }).expect(400);
    });

    it('rejects more category filters than the ceiling allows', async () => {
      await discover({
        ...baseBody,
        categories: Array.from({ length: 20 }, (_, i) => `CATEGORY_${String(i)}`),
      }).expect(400);
    });

    it('rejects a detour ceiling outside the accepted range', async () => {
      await discover({ ...baseBody, maxDetourMinutes: 0 }).expect(400);
      await discover({ ...baseBody, maxDetourMinutes: 10_000 }).expect(400);
    });

    it('clamps a detour ceiling above the server maximum rather than trusting it', async () => {
      /* 500 is valid input but above the configured 120-minute ceiling. It is clamped,
         not rejected: the request is meaningful, it just cannot be granted in full. */
      await discover({ ...baseBody, maxDetourMinutes: 500 }).expect(200);
    });

    it('clamps an oversized limit', async () => {
      const response = await discover({ ...baseBody, limit: 100 }).expect(200);
      const candidates = (response.body as Record<string, unknown>).candidates as unknown[];

      expect(candidates.length).toBeLessThanOrEqual(20);
    });

    it('spends nothing upstream on an invalid request', async () => {
      await discover({ origin: RECIFE, destination: RECIFE }).expect(400);

      expect(costs.calls).toBe(0);
    });
  });

  describe('empty results (§52)', () => {
    it('returns 200 with no candidates when nothing is near the route', async () => {
      const response = await discover({ ...baseBody, corridorWidthMeters: 100 }).expect(200);
      const body = response.body as Record<string, unknown>;

      /* "Nothing along this route" is an answer, not a failure. */
      expect(mine(body)).toEqual([]);
      expect(body.policyVersion).toBe('v1');
    });

    it('returns 200 when every candidate is over the detour ceiling', async () => {
      const response = await discover({ ...baseBody, maxDetourMinutes: 1 }).expect(200);
      expect(mine(response.body as Record<string, unknown>)).toEqual([]);
    });

    it('returns 200 when a category matches no Place near the route', async () => {
      const response = await discover({ ...baseBody, categories: ['ACCOMMODATION'] }).expect(200);
      expect(mine(response.body as Record<string, unknown>)).toEqual([]);
    });
  });

  describe('provider failures (§50)', () => {
    it('maps an unroutable pair to 422', async () => {
      routing.failure = new RouteNotFoundError();

      const response = await discover(baseBody).expect(422);
      expect((response.body as ErrorResponse).error.code).toBe('ROUTE_NOT_FOUND');
    });

    it('maps an unavailable routing provider to 502', async () => {
      routing.failure = new RoutingProviderUnavailableError();

      const response = await discover(baseBody).expect(502);
      expect((response.body as ErrorResponse).error.code).toBe('PROVIDER_UNAVAILABLE');
    });

    it('maps an unavailable cost provider to 502', async () => {
      costs.failure = new RoutingProviderUnavailableError();

      const response = await discover(baseBody).expect(502);
      expect((response.body as ErrorResponse).error.code).toBe('PROVIDER_UNAVAILABLE');
    });

    it('maps a cost provider timeout to 504', async () => {
      costs.failure = new RoutingProviderTimeoutError();

      const response = await discover(baseBody).expect(504);
      expect((response.body as ErrorResponse).error.code).toBe('PROVIDER_TIMEOUT');
    });

    it('never leaks a provider name or credential in an error', async () => {
      costs.failure = new RoutingProviderUnavailableError();

      const response = await discover(baseBody).expect(502);
      const serialised = JSON.stringify(response.body);

      expect(serialised.toLowerCase()).not.toContain('mapbox');
      expect(serialised).not.toContain('access_token');
    });
  });

  describe('rate limiting (§42)', () => {
    /* Sequential rather than a parallel burst: a burst leaves requests in flight when
       the assertion resolves, and those land during the next test and corrupt its
       call counts. The limiter is what is under test, not the server's concurrency. */
    const exhaust = async (attempts: number): Promise<request.Response[]> => {
      const responses: request.Response[] = [];
      for (let i = 0; i < attempts; i += 1) {
        responses.push(await discover(baseBody));
      }
      return responses;
    };

    it('rejects once the hourly ceiling is exhausted', async () => {
      /* The configured ceiling is 20 per user per hour. */
      const responses = await exhaust(22);

      expect(responses.map((r) => r.status)).toContain(429);

      const limited = responses.find((r) => r.status === 429);
      expect((limited?.body as ErrorResponse).error.code).toBe('TOO_MANY_REQUESTS');
    });

    it('tells the caller when to retry', async () => {
      const responses = await exhaust(22);
      const limited = responses.find((r) => r.status === 429);

      const details = (limited?.body as ErrorResponse).error.details as
        { retryAfterSeconds?: number } | undefined;
      expect(details?.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  describe('cost protection (§83, §98)', () => {
    it('makes one cost-provider call per discovery, whatever the candidate count', async () => {
      await discover(baseBody).expect(200);

      expect(costs.calls).toBe(1);
    });

    it('never asks the cost provider for more via-points than it can carry', async () => {
      await discover(baseBody).expect(200);

      for (const req of costs.requests) {
        expect(req.via.length).toBeLessThanOrEqual(costs.maxViaPointsPerCall);
      }
    });
  });

  describe('persistence (§45, §53)', () => {
    it('creates no rows for a discovery', async () => {
      const before = await database.db.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM places`,
      );

      await discover(baseBody).expect(200);

      const after = await database.db.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM places`,
      );

      /* Neither the route, the corridor, the candidates nor the intent are recorded. */
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    });

    it('has no discovery table to write to', async () => {
      const tables = await database.db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
      `);
      const names = tables.rows.map((r) => r.table_name);

      expect(names).not.toContain('route_candidates');
      expect(names).not.toContain('discoveries');
      expect(names).not.toContain('route_relevance');
    });
  });
});
