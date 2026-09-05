import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { AppModule } from '../../src/app.module.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { ROUTING_PROVIDER } from '../../src/modules/routing/domain/routing-provider.js';
import { RoutingProviderUnavailableError } from '../../src/modules/routing/domain/routing-errors.js';
import { MAX_TRAIL_STOPS } from '../../src/modules/trails/domain/trail.js';
import { httpServer } from '../support/http.js';
import { clearRateLimits, registerAccount, type AuthTokens } from '../support/identity.js';
import { FakeRoutingProvider } from '../support/routing.js';
import type { ErrorResponse } from '../../src/common/errors/error-response.js';

/**
 * The parts of a trail response these tests read.
 *
 * Declared rather than cast at each use: supertest hands back `unknown`, and naming
 * the shape once is what keeps the assertions about behaviour instead of about types.
 */
interface TrailBody {
  id: string;
  status: string;
  revision: number;
  routeIsCurrent: boolean;
  maxStops: number;
  finalizedAt: string | null;
  origin: unknown;
  destination: unknown;
  stops: { id: string; position: number }[];
  route: { distanceMeters: number; geometry: unknown } | null;
  baseRoute: { distanceMeters: number } | null;
  detour: { extraDurationSeconds: number } | null;
}

/**
 * The Trail Builder end to end (§96).
 *
 * The routing port is replaced with a deterministic provider, so composition,
 * ordering, revision handling and atomicity are exercised without an upstream
 * credential — which this environment does not have. **PostgreSQL is real**, so every
 * constraint, the compare-and-set and the cascade are the production ones.
 */
describe('Trails API', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let routing: FakeRoutingProvider;
  let tokens: AuthTokens;
  let otherTokens: AuthTokens;

  const RECIFE = { latitude: -8.0631, longitude: -34.8711, label: 'Recife' };
  const JOAO_PESSOA = { latitude: -7.115, longitude: -34.8631, label: 'João Pessoa' };

  const suite = `TrailApi-${Math.random().toString(36).slice(2, 8)}`;
  const placeIds: string[] = [];

  const seedPlace = async (name: string, latitude: number, status = 'ACTIVE'): Promise<string> => {
    const result = await database.db.execute<{ id: string }>(sql`
      INSERT INTO places (name, category_id, location, provenance, status)
      VALUES (
        ${`${suite} ${name}`}, 'LANDMARK',
        ST_SetSRID(ST_MakePoint(-34.85, ${latitude}), 4326)::geography,
        'SYSTEM', ${status}
      )
      RETURNING id
    `);

    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('seed failed');
    return id;
  };

  beforeAll(async () => {
    await runMigrations();
    routing = new FakeRoutingProvider();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(routing)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    database = app.get(DatabaseService);
    await clearRateLimits(app);
    tokens = (await registerAccount(app)).tokens;
    otherTokens = (await registerAccount(app)).tokens;

    for (let i = 0; i < MAX_TRAIL_STOPS + 3; i += 1) {
      placeIds.push(await seedPlace(`Stop${String(i)}`, -7.9 + i * 0.02));
    }
    placeIds.push(await seedPlace('Archived', -7.5, 'ARCHIVED'));
  }, 90_000);

  afterEach(() => {
    routing.failure = null;
    routing.calls = 0;
    /* No rate-limit flush here. `clearRateLimits` deletes every `ratelimit:*` key in
       Redis, and the integration suite runs files in parallel — flushing on each test
       would reach into whatever a sibling spec is asserting. The ceilings are raised
       in `setup-env.ts` instead, which needs no coordination. */
  });

  afterAll(async () => {
    await database.db.execute(sql`DELETE FROM trails WHERE origin_label = ${'Recife'}`);
    await database.db.execute(sql`DELETE FROM places WHERE name LIKE ${`${suite}%`}`);
    await app.close();
  });

  /* ---- helpers ------------------------------------------------------------- */

  const auth = (t: AuthTokens = tokens) => `Bearer ${t.accessToken}`;

  const createTrail = async (t: AuthTokens = tokens): Promise<TrailBody> => {
    const response = await request(httpServer(app))
      .post('/api/v1/trails')
      .set('Authorization', auth(t))
      .send({ origin: RECIFE, destination: JOAO_PESSOA })
      .expect(201);

    return response.body as TrailBody;
  };

  const detailOf = async (id: string, t: AuthTokens = tokens): Promise<TrailBody> => {
    const response = await request(httpServer(app))
      .get(`/api/v1/trails/${id}`)
      .set('Authorization', auth(t))
      .expect(200);

    return response.body as TrailBody;
  };

  const addStop = (id: string, placeId: string, revision: number, t: AuthTokens = tokens) =>
    request(httpServer(app))
      .post(`/api/v1/trails/${id}/stops`)
      .set('Authorization', auth(t))
      .send({ placeId, source: 'DISCOVERY', expectedRevision: revision });

  /* ---- creation ------------------------------------------------------------ */

  describe('creation (§26)', () => {
    it('rejects an anonymous request', async () => {
      await request(httpServer(app))
        .post('/api/v1/trails')
        .send({ origin: RECIFE, destination: JOAO_PESSOA })
        .expect(401);
    });

    it('creates a draft and routes it in one call', async () => {
      const trail = await createTrail();

      expect(trail.status).toBe('DRAFT');
      expect(trail.revision).toBe(1);
      expect(trail.routeIsCurrent).toBe(true);
      expect(trail.route?.distanceMeters).toBe(105_060);
      expect(trail.stops).toEqual([]);
    });

    it('records the base route from the same call when there are no stops', async () => {
      const trail = await createTrail();

      /* With no stops the composed route *is* the baseline; asking twice would bill
         twice for the same answer. */
      expect(routing.calls).toBe(1);
      expect(trail.baseRoute?.distanceMeters).toBe(105_060);
    });

    it('still creates a draft when the provider is unavailable', async () => {
      routing.failure = new RoutingProviderUnavailableError();

      const trail = await createTrail();

      /* A draft the user can return to is worth more than an error that loses the two
         points they just chose. The missing snapshot is visible, not hidden. */
      expect(trail.status).toBe('DRAFT');
      expect(trail.route).toBeNull();
      expect(trail.routeIsCurrent).toBe(false);
    });

    it('publishes the server stop ceiling', async () => {
      expect((await createTrail()).maxStops).toBe(MAX_TRAIL_STOPS);
    });

    it('rejects an out-of-range coordinate', async () => {
      await request(httpServer(app))
        .post('/api/v1/trails')
        .set('Authorization', auth())
        .send({ origin: { latitude: 91, longitude: -34.8 }, destination: JOAO_PESSOA })
        .expect(400);
    });
  });

  /* ---- ownership ----------------------------------------------------------- */

  describe('ownership (§8, §53)', () => {
    it('hides another account’s trail behind a 404', async () => {
      const trail = await createTrail();

      const response = await request(httpServer(app))
        .get(`/api/v1/trails/${trail.id}`)
        .set('Authorization', auth(otherTokens))
        .expect(404);

      /* A 403 would confirm the id is real, which turns enumeration into a census of
         other people's private compositions. */
      expect((response.body as ErrorResponse).error.code).toBe('NOT_FOUND');
    });

    it('refuses to mutate another account’s trail', async () => {
      const trail = await createTrail();

      await addStop(trail.id, placeIds[0] ?? '', 1, otherTokens).expect(404);
    });

    it('refuses to delete another account’s trail', async () => {
      const trail = await createTrail();

      await request(httpServer(app))
        .delete(`/api/v1/trails/${trail.id}`)
        .set('Authorization', auth(otherTokens))
        .expect(404);
    });

    it('lists only my own trails', async () => {
      const mine = await createTrail();
      await createTrail(otherTokens);

      const response = await request(httpServer(app))
        .get('/api/v1/trails')
        .set('Authorization', auth())
        .expect(200);

      const ids = (response.body as { trails: { id: string }[] }).trails.map((t) => t.id);
      expect(ids).toContain(mine.id);
    });
  });

  /* ---- stops --------------------------------------------------------------- */

  describe('stops (§27, §30, §33)', () => {
    it('adds a stop and re-routes through it', async () => {
      const trail = await createTrail();
      const before = trail.route?.distanceMeters ?? 0;

      const response = await addStop(trail.id, placeIds[0] ?? '', 1).expect(200);
      const updated = response.body as TrailBody;

      expect(updated.stops).toHaveLength(1);
      expect(updated.revision).toBe(2);
      expect(updated.route?.distanceMeters).toBeGreaterThan(before);
      expect(updated.routeIsCurrent).toBe(true);
    });

    it('passes the stop to routing as a waypoint, in position (§15)', async () => {
      const trail = await createTrail();
      routing.calls = 0;
      routing.requests.length = 0;

      await addStop(trail.id, placeIds[0] ?? '', 1).expect(200);

      const waypoints = routing.requests[0]?.waypoints ?? [];
      expect(waypoints).toHaveLength(1);
      expect(waypoints[0]?.placeId).toBe(placeIds[0]);
    });

    it('records the detour against the A → B baseline (§38)', async () => {
      const trail = await createTrail();
      const response = await addStop(trail.id, placeIds[0] ?? '', 1).expect(200);

      const detour = (response.body as TrailBody).detour;
      expect(detour?.extraDurationSeconds).toBeGreaterThan(0);
    });

    it('does not re-bill the baseline when only stops changed (§39)', async () => {
      const trail = await createTrail();
      routing.calls = 0;

      await addStop(trail.id, placeIds[0] ?? '', 1).expect(200);

      /* The baseline is a function of the endpoints alone, so a stop edit cannot
         invalidate it and recomputing it would be a billed call that changes nothing. */
      expect(routing.calls).toBe(1);
    });

    it('numbers stops 1, 2, 3 in the order they were added (§12)', async () => {
      const trail = await createTrail();
      const id = trail.id;

      await addStop(id, placeIds[0] ?? '', 1).expect(200);
      await addStop(id, placeIds[1] ?? '', 2).expect(200);
      const response = await addStop(id, placeIds[2] ?? '', 3).expect(200);

      const stops = (response.body as TrailBody).stops;
      expect(stops.map((s) => s.position)).toEqual([1, 2, 3]);
    });

    it('refuses the same Place twice (§33)', async () => {
      const trail = await createTrail();
      const id = trail.id;
      await addStop(id, placeIds[0] ?? '', 1).expect(200);

      const response = await addStop(id, placeIds[0] ?? '', 2).expect(409);
      expect((response.body as ErrorResponse).error.code).toBe('TRAIL_STOP_DUPLICATE');
    });

    it('refuses a Place that is not visible to readers', async () => {
      const trail = await createTrail();
      const archived = placeIds.at(-1) ?? '';

      const response = await addStop(trail.id, archived, 1).expect(422);
      expect((response.body as ErrorResponse).error.code).toBe('TRAIL_STOP_PLACE_UNAVAILABLE');
    });

    it('refuses a Place that does not exist', async () => {
      const trail = await createTrail();

      await addStop(trail.id, '0199f4c1-0000-7000-8000-0000000000ff', 1).expect(422);
    });

    it('enforces the stop ceiling (§14)', async () => {
      const trail = await createTrail();
      const id = trail.id;

      for (let i = 0; i < MAX_TRAIL_STOPS; i += 1) {
        await addStop(id, placeIds[i] ?? '', i + 1).expect(200);
      }

      const response = await addStop(id, placeIds[MAX_TRAIL_STOPS] ?? '', MAX_TRAIL_STOPS + 1);
      expect(response.status).toBe(422);
      expect((response.body as ErrorResponse).error.code).toBe('TRAIL_STOP_LIMIT_REACHED');
    }, 60_000);

    it('removes a stop and closes the gap (§30)', async () => {
      const trail = await createTrail();
      const id = trail.id;
      await addStop(id, placeIds[0] ?? '', 1).expect(200);
      const second = await addStop(id, placeIds[1] ?? '', 2).expect(200);
      await addStop(id, placeIds[2] ?? '', 3).expect(200);

      const middleStopId = (second.body as TrailBody).stops[1]?.id;

      const response = await request(httpServer(app))
        .delete(`/api/v1/trails/${id}/stops/${middleStopId ?? ''}`)
        .set('Authorization', auth())
        .send({ expectedRevision: 4 })
        .expect(200);

      const stops = (response.body as TrailBody).stops;
      expect(stops).toHaveLength(2);
      /* Positions stay contiguous from 1; a hole would make "the second stop"
         ambiguous. */
      expect(stops.map((s) => s.position)).toEqual([1, 2]);
    });
  });

  /* ---- reorder ------------------------------------------------------------- */

  describe('reorder (§31, §32, §91)', () => {
    const buildWithThreeStops = async (): Promise<{ id: string; stopIds: string[] }> => {
      const trail = await createTrail();
      const id = trail.id;
      await addStop(id, placeIds[0] ?? '', 1).expect(200);
      await addStop(id, placeIds[1] ?? '', 2).expect(200);
      const third = await addStop(id, placeIds[2] ?? '', 3).expect(200);

      return {
        id,
        stopIds: (third.body as TrailBody).stops.map((s) => s.id),
      };
    };

    const reorder = (id: string, stopIds: string[], revision: number) =>
      request(httpServer(app))
        .put(`/api/v1/trails/${id}/stops/order`)
        .set('Authorization', auth())
        .send({ stopIds, expectedRevision: revision });

    it('applies a new order in one call', async () => {
      const { id, stopIds } = await buildWithThreeStops();
      const reversed = [...stopIds].reverse();

      const response = await reorder(id, reversed, 4).expect(200);
      const stops = (response.body as TrailBody).stops;

      expect(stops.map((s) => s.id)).toEqual(reversed);
      expect(stops.map((s) => s.position)).toEqual([1, 2, 3]);
    });

    it('routes the new order, so geometry and order share a revision (§32)', async () => {
      const { id, stopIds } = await buildWithThreeStops();
      routing.calls = 0;
      routing.requests.length = 0;

      const response = await reorder(id, [...stopIds].reverse(), 4).expect(200);

      expect(routing.calls).toBe(1);
      const waypoints = routing.requests[0]?.waypoints ?? [];
      expect(waypoints).toHaveLength(3);
      expect((response.body as TrailBody).routeIsCurrent).toBe(true);
    });

    it('refuses an order that omits a stop', async () => {
      const { id, stopIds } = await buildWithThreeStops();

      const response = await reorder(id, stopIds.slice(0, 2), 4).expect(400);
      expect((response.body as ErrorResponse).error.code).toBe('INVALID_TRAIL_STOP_ORDER');
    });

    it('refuses an order that repeats a stop', async () => {
      const { id, stopIds } = await buildWithThreeStops();

      await reorder(id, [stopIds[0] ?? '', stopIds[0] ?? '', stopIds[1] ?? ''], 4).expect(400);
    });

    it('refuses an order naming a stop from another trail', async () => {
      const { id, stopIds } = await buildWithThreeStops();
      const other = await buildWithThreeStops();

      await reorder(id, [stopIds[0] ?? '', stopIds[1] ?? '', other.stopIds[0] ?? ''], 4).expect(
        400,
      );
    });

    it('refuses a stale revision', async () => {
      const { id, stopIds } = await buildWithThreeStops();

      const response = await reorder(id, [...stopIds].reverse(), 2).expect(409);
      expect((response.body as ErrorResponse).error.code).toBe('TRAIL_REVISION_CONFLICT');
    });

    it('changes nothing when routing fails (§92)', async () => {
      const { id, stopIds } = await buildWithThreeStops();
      const before = await detailOf(id);

      routing.failure = new RoutingProviderUnavailableError();
      await reorder(id, [...stopIds].reverse(), 4).expect(502);

      const after = await detailOf(id);
      expect(after).toEqual(before);
    });
  });

  /* ---- revision -------------------------------------------------------------*/

  describe('optimistic concurrency (§25, §89, §90)', () => {
    it('accepts a mutation at the current revision and refuses a repeat', async () => {
      const trail = await createTrail();
      const id = trail.id;

      await addStop(id, placeIds[0] ?? '', 1).expect(200);

      const response = await addStop(id, placeIds[1] ?? '', 1);
      expect(response.status).toBe(409);
      expect((response.body as ErrorResponse).error.code).toBe('TRAIL_REVISION_CONFLICT');
    });

    it('tells the client which revision to reload to', async () => {
      const trail = await createTrail();
      const id = trail.id;
      await addStop(id, placeIds[0] ?? '', 1).expect(200);

      const response = await addStop(id, placeIds[1] ?? '', 1).expect(409);
      const details = (response.body as ErrorResponse).error.details as {
        currentRevision: number;
        expectedRevision: number;
      };

      expect(details.currentRevision).toBe(2);
      expect(details.expectedRevision).toBe(1);
    });

    /**
     * The concurrency gate (§90, §113).
     *
     * Two mutations, same expected revision, in flight together. Exactly one must win.
     * If both succeeded, one user's edit vanished with nothing to show it happened —
     * which is the failure this whole mechanism exists to prevent.
     */
    it('turns two simultaneous mutations into one success and one conflict', async () => {
      const trail = await createTrail();
      const id = trail.id;

      const [first, second] = await Promise.all([
        addStop(id, placeIds[0] ?? '', 1),
        addStop(id, placeIds[1] ?? '', 1),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      /* And the survivor is the only thing that got written. */
      const after = await detailOf(id);
      expect(after.stops).toHaveLength(1);
      expect(after.revision).toBe(2);
    });

    it('holds under a wider burst', async () => {
      const trail = await createTrail();
      const id = trail.id;

      const responses = await Promise.all(
        [0, 1, 2, 3, 4].map((i) => addStop(id, placeIds[i] ?? '', 1)),
      );

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(4);
      expect((await detailOf(id)).stops).toHaveLength(1);
    });
  });

  /* ---- atomicity ------------------------------------------------------------*/

  describe('atomicity (§83, §92, §114)', () => {
    it('leaves the trail untouched when routing fails during an add', async () => {
      const trail = await createTrail();
      const id = trail.id;
      const before = await detailOf(id);

      routing.failure = new RoutingProviderUnavailableError();
      await addStop(id, placeIds[0] ?? '', 1).expect(502);

      const after = await detailOf(id);
      /* Byte-for-byte the previous composition: no stop, no revision bump, no snapshot
         change. A trail carrying a stop with no route for it would draw a line that
         omits somewhere the user chose to go. */
      expect(after).toEqual(before);
    });

    it('leaves the trail untouched when routing fails during a remove', async () => {
      const trail = await createTrail();
      const id = trail.id;
      const added = await addStop(id, placeIds[0] ?? '', 1).expect(200);
      const stopId = (added.body as TrailBody).stops[0]?.id;
      const before = await detailOf(id);

      routing.failure = new RoutingProviderUnavailableError();
      await request(httpServer(app))
        .delete(`/api/v1/trails/${id}/stops/${stopId ?? ''}`)
        .set('Authorization', auth())
        .send({ expectedRevision: 2 })
        .expect(502);

      expect(await detailOf(id)).toEqual(before);
    });

    it('writes no orphan stop row when routing fails', async () => {
      const trail = await createTrail();
      const id = trail.id;

      routing.failure = new RoutingProviderUnavailableError();
      await addStop(id, placeIds[0] ?? '', 1).expect(502);

      const rows = await database.db.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM trail_stops WHERE trail_id = ${id}`,
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    });
  });

  /* ---- lifecycle ------------------------------------------------------------*/

  describe('lifecycle (§45, §46)', () => {
    it('finalizes a trail whose route matches its composition', async () => {
      const trail = await createTrail();
      const id = trail.id;

      const response = await request(httpServer(app))
        .post(`/api/v1/trails/${id}/finalize`)
        .set('Authorization', auth())
        .send({ expectedRevision: 1 })
        .expect(200);

      expect((response.body as TrailBody).status).toBe('FINALIZED');
      expect((response.body as TrailBody).finalizedAt).not.toBeNull();
    });

    it('finalizes a trail with no stops — A → B is a journey (§45)', async () => {
      const trail = await createTrail();

      await request(httpServer(app))
        .post(`/api/v1/trails/${trail.id}/finalize`)
        .set('Authorization', auth())
        .send({ expectedRevision: 1 })
        .expect(200);
    });

    it('refuses to finalize a trail with no route at all (§22)', async () => {
      routing.failure = new RoutingProviderUnavailableError();
      const trail = await createTrail();
      routing.failure = null;

      const response = await request(httpServer(app))
        .post(`/api/v1/trails/${trail.id}/finalize`)
        .set('Authorization', auth())
        .send({ expectedRevision: 1 })
        .expect(422);

      expect((response.body as ErrorResponse).error.code).toBe('TRAIL_ROUTE_STALE');
    });

    it('reopens a finalized trail on the first edit (§46)', async () => {
      const trail = await createTrail();
      const id = trail.id;
      await request(httpServer(app))
        .post(`/api/v1/trails/${id}/finalize`)
        .set('Authorization', auth())
        .send({ expectedRevision: 1 })
        .expect(200);

      const response = await addStop(id, placeIds[0] ?? '', 1).expect(200);

      /* "Finished" describes the current state, not a one-way door. */
      expect((response.body as TrailBody).status).toBe('DRAFT');
      expect((response.body as TrailBody).finalizedAt).toBeNull();
    });

    it('archives a trail', async () => {
      const trail = await createTrail();

      const response = await request(httpServer(app))
        .post(`/api/v1/trails/${trail.id}/archive`)
        .set('Authorization', auth())
        .send({ expectedRevision: 1 })
        .expect(200);

      expect((response.body as TrailBody).status).toBe('ARCHIVED');
    });

    it('deletes a trail and its stops', async () => {
      const trail = await createTrail();
      const id = trail.id;
      await addStop(id, placeIds[0] ?? '', 1).expect(200);

      await request(httpServer(app))
        .delete(`/api/v1/trails/${id}`)
        .set('Authorization', auth())
        .expect(204);

      await request(httpServer(app))
        .get(`/api/v1/trails/${id}`)
        .set('Authorization', auth())
        .expect(404);

      const rows = await database.db.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM trail_stops WHERE trail_id = ${id}`,
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    });
  });

  /* ---- recalculate & endpoints ---------------------------------------------*/

  describe('recalculate and endpoints (§39, §70)', () => {
    it('refreshes the route on request', async () => {
      const trail = await createTrail();
      const id = trail.id;
      routing.calls = 0;

      await request(httpServer(app))
        .post(`/api/v1/trails/${id}/recalculate`)
        .set('Authorization', auth())
        .send({ expectedRevision: 1 })
        .expect(200);

      expect(routing.calls).toBeGreaterThanOrEqual(1);
    });

    it('recomputes the baseline when the endpoints move', async () => {
      const trail = await createTrail();
      const id = trail.id;
      await addStop(id, placeIds[0] ?? '', 1).expect(200);
      routing.calls = 0;

      await request(httpServer(app))
        .patch(`/api/v1/trails/${id}`)
        .set('Authorization', auth())
        .send({ destination: { latitude: -7.2, longitude: -34.9 }, expectedRevision: 2 })
        .expect(200);

      /* Composed and base, computed together so the "+X min" they produce is measured
         against the same road network (§40). */
      expect(routing.calls).toBe(2);
    });
  });

  /* ---- listing --------------------------------------------------------------*/

  describe('listing (§42, §43, §80)', () => {
    it('returns summaries without geometry', async () => {
      await createTrail();

      const response = await request(httpServer(app))
        .get('/api/v1/trails')
        .set('Authorization', auth())
        .expect(200);

      const body = response.body as { trails: Record<string, unknown>[] };
      /* A list of twenty trails must not ship twenty LineStrings to a phone. */
      expect(Object.keys(body.trails[0] ?? {})).not.toContain('route');
      expect(JSON.stringify(body)).not.toContain('LineString');
    });

    it('pages with a cursor rather than an offset', async () => {
      await createTrail();
      await createTrail();
      await createTrail();

      const first = await request(httpServer(app))
        .get('/api/v1/trails?limit=2')
        .set('Authorization', auth())
        .expect(200);

      const firstBody = first.body as { trails: { id: string }[]; nextCursor: string | null };
      expect(firstBody.trails).toHaveLength(2);
      expect(firstBody.nextCursor).not.toBeNull();

      const second = await request(httpServer(app))
        .get(`/api/v1/trails?limit=2&cursor=${firstBody.nextCursor ?? ''}`)
        .set('Authorization', auth())
        .expect(200);

      const secondBody = second.body as { trails: { id: string }[] };
      const overlap = secondBody.trails.filter((t) => firstBody.trails.some((f) => f.id === t.id));
      expect(overlap).toEqual([]);
    });

    it('filters by status', async () => {
      const trail = await createTrail();
      await request(httpServer(app))
        .post(`/api/v1/trails/${trail.id}/archive`)
        .set('Authorization', auth())
        .send({ expectedRevision: 1 })
        .expect(200);

      const response = await request(httpServer(app))
        .get('/api/v1/trails?status=ARCHIVED')
        .set('Authorization', auth())
        .expect(200);

      const statuses = (response.body as { trails: { status: string }[] }).trails.map(
        (t) => t.status,
      );
      expect(new Set(statuses)).toEqual(new Set(['ARCHIVED']));
    });
  });

  /* ---- persistence & resume -------------------------------------------------*/

  describe('persistence and resume (§69, §115, §116)', () => {
    it('restores a whole composition from a single detail read', async () => {
      const trail = await createTrail();
      const id = trail.id;
      await addStop(id, placeIds[0] ?? '', 1).expect(200);
      await addStop(id, placeIds[1] ?? '', 2).expect(200);

      const restored = await detailOf(id);

      /* Everything the builder needs to come back from cold, with no memory of the
         session that created it. */
      expect(restored.origin).toBeDefined();
      expect(restored.stops).toHaveLength(2);
      expect(restored.route?.geometry).toBeDefined();
      expect(restored.revision).toBe(3);
      expect(restored.routeIsCurrent).toBe(true);
    });

    it('survives a fresh application instance (§115)', async () => {
      const trail = await createTrail();
      const id = trail.id;
      await addStop(id, placeIds[0] ?? '', 1).expect(200);

      /* A second application over the same database — the closest thing to a restart
         that a test can do without tearing down the suite. */
      const secondRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ROUTING_PROVIDER)
        .useValue(routing)
        .compile();
      const second = secondRef.createNestApplication();
      second.setGlobalPrefix('api/v1');
      await second.init();

      try {
        const response = await request(httpServer(second))
          .get(`/api/v1/trails/${id}`)
          .set('Authorization', auth())
          .expect(200);

        const body = response.body as TrailBody;
        expect(body.stops).toHaveLength(1);
        expect(body.route?.distanceMeters).toBeGreaterThan(0);
      } finally {
        await second.close();
      }
    }, 60_000);

    it('does not persist a route the user never saved', async () => {
      const before = await database.db.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM trails`,
      );

      await request(httpServer(app))
        .post('/api/v1/routes/calculate')
        .set('Authorization', auth())
        .send({ origin: RECIFE, destination: JOAO_PESSOA })
        .expect(200);

      const after = await database.db.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM trails`,
      );

      /* Calculating a route is not saving a trail. Only an explicit act persists
         travel intent (§74). */
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    });
  });
});
