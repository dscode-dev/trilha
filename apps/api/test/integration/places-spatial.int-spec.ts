import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { httpServer } from '../support/http.js';
import { clearRateLimits } from '../support/identity.js';
import { LANDMARKS, contributor, createPlace, uniquePlaceName } from '../support/places.js';
import type { AuthTokens } from '../support/identity.js';

/**
 * Spatial queries against real PostgreSQL + PostGIS (§59, §60, §61).
 *
 * Distances are asserted against known real-world separations, not against whatever
 * the code happens to compute — a test that accepts its own output proves nothing.
 */
describe('Place spatial queries', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let tokens: AuthTokens;
  let suite: string;

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    await clearRateLimits(app);
    database = app.get(DatabaseService);
    tokens = await contributor(app);
    suite = uniquePlaceName('SpatialSuite');

    /* Seeded through the real endpoint, so the write path is exercised too. */
    await createPlace(app, tokens, {
      ...LANDMARKS.marcoZero,
      name: `${suite} Marco Zero`,
      categoryId: 'LANDMARK',
    });
    await createPlace(app, tokens, {
      ...LANDMARKS.igrejaDaSe,
      name: `${suite} Igreja da Sé`,
      categoryId: 'HISTORY_CULTURE',
    });
    await createPlace(app, tokens, {
      ...LANDMARKS.boaViagem,
      name: `${suite} Praia de Boa Viagem`,
      categoryId: 'NATURE',
    });
    await createPlace(app, tokens, {
      ...LANDMARKS.saoPaulo,
      name: `${suite} Café São Paulo`,
      categoryId: 'FOOD',
    });
  }, 60_000);

  afterAll(async () => {
    await database.db.execute(sql`DELETE FROM places WHERE name LIKE ${`${suite}%`}`);
    await app.close();
  });

  const nearby = (query: Record<string, string | number>) =>
    request(httpServer(app)).get('/api/v1/places/nearby').query(query);

  /**
   * Names created by this run only.
   *
   * The database is shared — with other suites, and with whatever a developer left
   * behind from a manual smoke. An assertion that matched on a bare place name found
   * an unrelated row and failed for the wrong reason, so every assertion filters on
   * the per-run prefix.
   */
  const ours = (names: string[]): string[] => names.filter((n) => n.startsWith(suite));

  describe('geography model (§6, §7)', () => {
    it('stores the location as geography(Point) in SRID 4326', async () => {
      const result = await database.db.execute<{ srid: number; type: string }>(
        sql`SELECT srid, type FROM geography_columns
             WHERE f_table_name = 'places' AND f_geography_column = 'location'`,
      );

      expect(result.rows[0]?.srid).toBe(4326);
      expect(result.rows[0]?.type).toBe('Point');
    });

    it('returns the coordinates it was given, without drift', async () => {
      const place = await createPlace(app, tokens, {
        ...LANDMARKS.jaboatao,
        name: `${suite} Roundtrip`,
      });

      const detail = await request(httpServer(app)).get(`/api/v1/places/${place.id}`).expect(200);

      const body = detail.body as { latitude: number; longitude: number };
      expect(body.latitude).toBeCloseTo(LANDMARKS.jaboatao.latitude, 6);
      expect(body.longitude).toBeCloseTo(LANDMARKS.jaboatao.longitude, 6);
    });

    it('measures a real distance in metres, not degrees', async () => {
      /* Marco Zero (Recife) to Igreja da Sé (Olinda) is ~6.2 km on the ground. A
         `geometry` column would answer this in degrees — about 0.056 — which is why
         the column is `geography` (ADR-0010). */
      const result = await database.db.execute<{ metres: number }>(sql`
        SELECT ST_Distance(
          ST_SetSRID(ST_MakePoint(${LANDMARKS.marcoZero.longitude}, ${LANDMARKS.marcoZero.latitude}), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${LANDMARKS.igrejaDaSe.longitude}, ${LANDMARKS.igrejaDaSe.latitude}), 4326)::geography
        ) AS metres
      `);

      const metres = Number(result.rows[0]?.metres);
      expect(metres).toBeGreaterThan(5_500);
      expect(metres).toBeLessThan(7_000);
    });
  });

  describe('GET /places/nearby (§17)', () => {
    it('finds a place at the query point with distance ~0', async () => {
      const response = await nearby({
        lat: LANDMARKS.marcoZero.latitude,
        lng: LANDMARKS.marcoZero.longitude,
        radiusMeters: 500,
      }).expect(200);

      const items = (response.body as { items: { name: string; distanceMetres: number }[] }).items;
      const marcoZero = items.find((i) => i.name === `${suite} Marco Zero`);

      expect(marcoZero).toBeDefined();
      expect(marcoZero?.distanceMetres).toBeLessThan(10);
    });

    it('excludes a place beyond the radius', async () => {
      /* Olinda is ~6.2 km away, so a 1 km radius must not reach it. */
      const response = await nearby({
        lat: LANDMARKS.marcoZero.latitude,
        lng: LANDMARKS.marcoZero.longitude,
        radiusMeters: 1_000,
      }).expect(200);

      const names = ours((response.body as { items: { name: string }[] }).items.map((i) => i.name));
      expect(names).not.toContain(`${suite} Igreja da Sé`);
    });

    it('includes it once the radius reaches', async () => {
      const response = await nearby({
        lat: LANDMARKS.marcoZero.latitude,
        lng: LANDMARKS.marcoZero.longitude,
        radiusMeters: 10_000,
      }).expect(200);

      const names = ours((response.body as { items: { name: string }[] }).items.map((i) => i.name));
      expect(names).toContain(`${suite} Igreja da Sé`);
    });

    it('orders results nearest first', async () => {
      const response = await nearby({
        lat: LANDMARKS.marcoZero.latitude,
        lng: LANDMARKS.marcoZero.longitude,
        radiusMeters: 50_000,
        limit: 50,
      }).expect(200);

      const distances = (response.body as { items: { distanceMetres: number }[] }).items.map(
        (i) => i.distanceMetres,
      );

      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    });

    it('filters by category', async () => {
      const response = await nearby({
        lat: LANDMARKS.marcoZero.latitude,
        lng: LANDMARKS.marcoZero.longitude,
        radiusMeters: 50_000,
        categoryId: 'NATURE',
        limit: 50,
      }).expect(200);

      const items = (response.body as { items: { categoryId: string }[] }).items;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.categoryId === 'NATURE')).toBe(true);
    });

    it('paginates', async () => {
      const first = await nearby({
        lat: LANDMARKS.marcoZero.latitude,
        lng: LANDMARKS.marcoZero.longitude,
        radiusMeters: 50_000,
        limit: 1,
        offset: 0,
      }).expect(200);

      const second = await nearby({
        lat: LANDMARKS.marcoZero.latitude,
        lng: LANDMARKS.marcoZero.longitude,
        radiusMeters: 50_000,
        limit: 1,
        offset: 1,
      }).expect(200);

      const firstBody = first.body as { items: { id: string }[]; hasMore: boolean };
      const secondBody = second.body as { items: { id: string }[] };

      expect(firstBody.items).toHaveLength(1);
      expect(firstBody.hasMore).toBe(true);
      expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);
    });

    it.each([
      ['latitude out of range', { lat: 91, lng: -34.8 }],
      ['longitude out of range', { lat: -8, lng: 181 }],
      ['a missing latitude', { lng: -34.8 }],
      ['an empty latitude', { lat: '', lng: -34.8 }],
      ['a non-numeric latitude', { lat: 'abc', lng: -34.8 }],
      ['a radius beyond the cap', { lat: -8, lng: -34.8, radiusMeters: 500_000 }],
      ['a zero radius', { lat: -8, lng: -34.8, radiusMeters: 0 }],
    ])('rejects %s', async (_name, query) => {
      await nearby(query as Record<string, string | number>).expect(400);
    });
  });

  describe('GET /places/map (§18)', () => {
    const map = (query: Record<string, string | number>) =>
      request(httpServer(app)).get('/api/v1/places/map').query(query);

    it('returns places inside the viewport', async () => {
      const response = await map({
        north: -8.0,
        south: -8.15,
        east: -34.8,
        west: -34.95,
      }).expect(200);

      const names = ours((response.body as { items: { name: string }[] }).items.map((i) => i.name));
      expect(names).toContain(`${suite} Marco Zero`);
      expect(names).toContain(`${suite} Praia de Boa Viagem`);
    });

    it('excludes places outside the viewport', async () => {
      const response = await map({
        north: -8.0,
        south: -8.15,
        east: -34.8,
        west: -34.95,
      }).expect(200);

      const names = ours((response.body as { items: { name: string }[] }).items.map((i) => i.name));
      /* São Paulo is 2000 km away and must not appear in a Recife viewport. */
      expect(names).not.toContain(`${suite} Café São Paulo`);
    });

    it('returns only what a marker needs (§27)', async () => {
      const response = await map({
        north: -8.0,
        south: -8.15,
        east: -34.8,
        west: -34.95,
      }).expect(200);

      const item = (response.body as { items: Record<string, unknown>[] }).items[0];
      expect(Object.keys(item ?? {}).sort()).toEqual([
        'categoryId',
        'id',
        'latitude',
        'longitude',
        'name',
      ]);
    });

    it.each([
      ['north below south', { north: -8.2, south: -8.0, east: -34.8, west: -34.95 }],
      ['a viewport crossing the antimeridian', { north: 10, south: -10, east: -179, west: 179 }],
      ['a world-spanning viewport', { north: 89, south: -89, east: 179, west: -179 }],
      ['an out-of-range corner', { north: 91, south: -8.1, east: -34.8, west: -34.95 }],
      ['a missing corner', { north: -8.0, south: -8.1, east: -34.8 }],
    ])('rejects %s', async (_name, query) => {
      await map(query as Record<string, string | number>).expect(400);
    });
  });

  describe('GET /places/search (§22)', () => {
    const search = (query: Record<string, string | number>) =>
      request(httpServer(app)).get('/api/v1/places/search').query(query);

    it('matches ignoring case', async () => {
      const response = await search({ q: 'MARCO ZERO', limit: 100 }).expect(200);
      const names = ours((response.body as { items: { name: string }[] }).items.map((i) => i.name));
      expect(names).toContain(`${suite} Marco Zero`);
    });

    it('matches ignoring accents, which Portuguese names need', async () => {
      /* "sao paulo" must find "Café São Paulo". */
      const response = await search({ q: 'sao paulo', limit: 100 }).expect(200);
      const names = ours((response.body as { items: { name: string }[] }).items.map((i) => i.name));
      expect(names).toContain(`${suite} Café São Paulo`);
    });

    it('matches an accented query against an accented name', async () => {
      const response = await search({ q: 'Igreja da Sé', limit: 100 }).expect(200);
      const names = ours((response.body as { items: { name: string }[] }).items.map((i) => i.name));
      expect(names).toContain(`${suite} Igreja da Sé`);
    });

    it('matches a partial term', async () => {
      const response = await search({ q: 'Boa Via', limit: 100 }).expect(200);
      const names = ours((response.body as { items: { name: string }[] }).items.map((i) => i.name));
      expect(names).toContain(`${suite} Praia de Boa Viagem`);
    });

    it('returns an empty page rather than an error for no matches', async () => {
      const response = await search({ q: 'zzzz-no-such-place-zzzz' }).expect(200);
      expect((response.body as { items: unknown[] }).items).toEqual([]);
    });

    it('carries distances when a reference point is supplied', async () => {
      const response = await search({
        q: `${suite} Marco`,
        lat: LANDMARKS.marcoZero.latitude,
        lng: LANDMARKS.marcoZero.longitude,
      }).expect(200);

      const item = (response.body as { items: { distanceMetres: number | null }[] }).items[0];
      expect(item?.distanceMetres).not.toBeNull();
      expect(item?.distanceMetres).toBeLessThan(10);
    });

    it('omits distance when there is no reference point', async () => {
      const response = await search({ q: `${suite} Marco` }).expect(200);
      const item = (response.body as { items: { distanceMetres: number | null }[] }).items[0];
      expect(item?.distanceMetres).toBeNull();
    });

    it.each([
      ['an empty query', { q: '' }],
      ['a single character', { q: 'a' }],
      ['an over-long query', { q: 'x'.repeat(200) }],
    ])('rejects %s', async (_name, query) => {
      await search(query as Record<string, string>).expect(400);
    });
  });

  /**
   * Index usage (§29, §30, §61).
   *
   * A planner given five rows will choose a sequential scan every time, and it is
   * right to — an index lookup costs more than reading the whole table. So this block
   * seeds enough volume for the choice to be meaningful before asking what the
   * planner does. Measured at this size, the viewport query runs in ~0.8 ms against
   * ~23 ms for the un-indexed form.
   *
   * The assertions check that the index is *reachable*, not that one exact plan is
   * produced: pinning a whole plan would break on any planner improvement, while
   * still missing the regression that matters.
   */
  describe('query plans at volume', () => {
    const PLAN_ROWS = 20_000;
    const planSuite = `PlanBench-${Math.random().toString(36).slice(2, 8)}`;

    beforeAll(async () => {
      await database.db.execute(sql`
        INSERT INTO places (name, category_id, location, provenance, status)
        SELECT ${planSuite} || ' ' || g,
               'LANDMARK',
               ST_SetSRID(ST_MakePoint(-35.5 + random() * 3.0, -9.5 + random() * 3.0), 4326)::geography,
               'SYSTEM',
               'ACTIVE'
          FROM generate_series(1, ${PLAN_ROWS}) g
      `);
      /* Without fresh statistics the planner is choosing on stale row counts. */
      await database.db.execute(sql`ANALYZE places`);
    }, 120_000);

    afterAll(async () => {
      await database.db.execute(sql`DELETE FROM places WHERE name LIKE ${`${planSuite}%`}`);
      await database.db.execute(sql`ANALYZE places`);
    }, 120_000);

    const planFor = async (query: ReturnType<typeof sql>): Promise<string> => {
      const result = await database.db.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN (COSTS OFF) ${query}`,
      );
      return result.rows.map((r) => r['QUERY PLAN']).join('\n');
    };

    /**
     * The plan with sequential scans disabled.
     *
     * Whether the planner *chooses* an index depends on table size and cost
     * estimates — at 20k rows a sequential scan is genuinely cheaper for a selective
     * ILIKE, and asserting otherwise would make the test a hostage to the planner
     * (§61). What must not regress is whether the index can serve the predicate at
     * all, and disabling seqscan asks exactly that question. Run inside a
     * transaction so the setting cannot leak onto a pooled connection.
     */
    const reachablePlanFor = async (query: ReturnType<typeof sql>): Promise<string> =>
      database.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const result = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN (COSTS OFF) ${query}`,
        );
        return result.rows.map((r) => r['QUERY PLAN']).join('\n');
      });

    it('the radius query uses the spatial index', async () => {
      const plan = await planFor(sql`
        SELECT p.id FROM places p
         WHERE p.status = 'ACTIVE'
           AND ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(-34.0, -8.0), 4326)::geography, 2000)
      `);

      expect(plan).toMatch(/places_location_gist_idx/);
    });

    it('the viewport query uses the spatial index', async () => {
      const plan = await planFor(sql`
        SELECT p.id FROM places p
         WHERE p.status = 'ACTIVE'
           AND p.location && ST_MakeEnvelope(-34.1, -8.1, -33.9, -7.9, 4326)::geography
      `);

      expect(plan).toMatch(/places_location_gist_idx/);
    });

    it('casting the column instead of the envelope makes the index unreachable', async () => {
      /* The trap this code avoids: measured at 40k rows, the cast form ran a
         sequential scan at 23 ms against 0.8 ms for the indexed form. Checked with
         seqscan disabled, so this asserts the index genuinely *cannot* serve the
         predicate rather than that the planner merely preferred not to. */
      const plan = await reachablePlanFor(sql`
        SELECT p.id FROM places p
         WHERE p.status = 'ACTIVE'
           AND p.location::geometry && ST_MakeEnvelope(-34.1, -8.1, -33.9, -7.9, 4326)
      `);

      expect(plan).not.toMatch(/places_location_gist_idx/);
    });

    it('the search predicate can be served by the trigram index', async () => {
      const plan = await reachablePlanFor(sql`
        SELECT p.id FROM places p
         WHERE p.status = 'ACTIVE'
           AND p.search_text ILIKE ${`%${planSuite.toLowerCase()} 12345%`}
      `);

      expect(plan).toMatch(/places_search_text_trgm_idx/);
    });
  });
});
