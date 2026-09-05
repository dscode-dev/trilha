import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { PlacesAlongRouteQuery } from '../../src/modules/places/application/places-along-route.query.js';

/**
 * Spatial candidate retrieval against real PostGIS (§11, §12, §68, §69, §70).
 *
 * Independent of any provider: the route is a fixed LineString, so every assertion
 * here is about PostGIS and Trilha's retrieval strategy, and they hold whether or not
 * an upstream credential exists.
 */
describe('Discovery spatial retrieval (PostGIS)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let places: PlacesAlongRouteQuery;

  /** Simplified BR-101, Recife → João Pessoa, ~105 km. Real coordinates. */
  const route = JSON.stringify({
    type: 'LineString',
    coordinates: [
      [-34.8711, -8.0631],
      [-34.86, -7.98],
      [-34.85, -7.85],
      [-34.84, -7.6],
      [-34.85, -7.4],
      [-34.8631, -7.115],
    ],
  });

  const suite = `DiscSpatial-${Math.random().toString(36).slice(2, 8)}`;

  /** Inserts a Place and returns its id. */
  const seed = async (params: {
    name: string;
    latitude: number;
    longitude: number;
    categoryId?: string;
    status?: string;
  }): Promise<string> => {
    const result = await database.db.execute<{ id: string }>(sql`
      INSERT INTO places (name, category_id, location, provenance, status)
      VALUES (
        ${`${suite} ${params.name}`},
        ${params.categoryId ?? 'LANDMARK'},
        ST_SetSRID(ST_MakePoint(${params.longitude}, ${params.latitude}), 4326)::geography,
        'SYSTEM',
        ${params.status ?? 'ACTIVE'}
      )
      RETURNING id
    `);

    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('seed failed');
    return id;
  };

  const query = (overrides: Partial<Parameters<PlacesAlongRouteQuery['execute']>[0]> = {}) =>
    places.execute({
      routeGeoJson: route,
      corridorWidthMeters: 5_000,
      categoryIds: [],
      limit: 1_000,
      ...overrides,
    });

  /**
   * This suite's own Places.
   *
   * The product query has no name filter — nor should it — so results are scoped here
   * instead. Integration specs share one database, and a test that only passes when it
   * runs alone is not testing what it claims to.
   */
  const mine = async (
    overrides: Partial<Parameters<PlacesAlongRouteQuery['execute']>[0]> = {},
  ): Promise<Awaited<ReturnType<PlacesAlongRouteQuery['execute']>>> => {
    const rows = await query(overrides);
    return rows.filter((row) => row.name.startsWith(suite));
  };

  const namesFrom = (rows: { name: string }[]): string[] =>
    rows.map((row) => row.name.replace(`${suite} `, ''));

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    database = app.get(DatabaseService);
    places = app.get(PlacesAlongRouteQuery);
  }, 60_000);

  afterAll(async () => {
    await database.db.execute(sql`DELETE FROM places WHERE name LIKE ${`${suite}%`}`);
    await app.close();
  });

  describe('corridor membership (§68)', () => {
    let inside: string;

    beforeAll(async () => {
      /* ~1 km east of the line at the midpoint. */
      inside = await seed({ name: 'Inside', latitude: -7.85, longitude: -34.84 });
      /* ~60 km inland — well outside any sane corridor. */
      await seed({ name: 'FarInland', latitude: -7.85, longitude: -35.4 });
      /* ~8 km east: outside 5 km, inside 20 km. */
      await seed({ name: 'EightKm', latitude: -7.85, longitude: -34.78 });
      await seed({ name: 'Archived', latitude: -7.84, longitude: -34.85, status: 'ARCHIVED' });
      await seed({ name: 'Pending', latitude: -7.83, longitude: -34.85, status: 'PENDING_REVIEW' });
      await seed({ name: 'Restaurant', latitude: -7.82, longitude: -34.85, categoryId: 'FOOD' });
    });

    it('includes a Place beside the route', async () => {
      const rows = await mine();
      expect(rows.map((r) => r.id)).toContain(inside);
    });

    it('excludes a Place far from the route', async () => {
      expect(namesFrom(await mine())).not.toContain('FarInland');
    });

    it('respects the corridor width at the boundary', async () => {
      expect(namesFrom(await mine({ corridorWidthMeters: 5_000 }))).not.toContain('EightKm');
      expect(namesFrom(await mine({ corridorWidthMeters: 20_000 }))).toContain('EightKm');
    });

    it('excludes an archived Place', async () => {
      /* Only ACTIVE Places are visible to readers, and discovery is a read. */
      expect(namesFrom(await mine())).not.toContain('Archived');
    });

    it('excludes a Place still awaiting review', async () => {
      expect(namesFrom(await mine())).not.toContain('Pending');
    });

    it('applies the category filter in SQL', async () => {
      const rows = await mine({ categoryIds: ['FOOD'] });

      expect(namesFrom(rows)).toContain('Restaurant');
      expect(namesFrom(rows)).not.toContain('Inside');
    });

    it('accepts several categories at once', async () => {
      const rows = await mine({ categoryIds: ['FOOD', 'LANDMARK'] });

      expect(namesFrom(rows)).toContain('Restaurant');
      expect(namesFrom(rows)).toContain('Inside');
    });

    it('treats an empty category list as no filter', async () => {
      expect(namesFrom(await mine({ categoryIds: [] })).length).toBeGreaterThan(1);
    });

    it('caps the result set', async () => {
      const rows = await query({ limit: 2 });
      expect(rows).toHaveLength(2);
    });
  });

  describe('distance from the route (§14, §69)', () => {
    beforeAll(async () => {
      /* 0.01° of longitude at latitude −7.85 is ≈1.10 km. */
      await seed({ name: 'Dist1km', latitude: -7.85, longitude: -34.84 });
      await seed({ name: 'Dist3km', latitude: -7.85, longitude: -34.82 });
    });

    it('measures a known offset in metres, not degrees', async () => {
      const rows = await mine({ corridorWidthMeters: 20_000 });
      const oneKm = rows.find((r) => r.name.endsWith('Dist1km'));

      /* A degree-based answer would be ≈0.01 — five orders of magnitude out. */
      expect(oneKm?.distanceFromRouteMeters).toBeGreaterThan(900);
      expect(oneKm?.distanceFromRouteMeters).toBeLessThan(1_300);
    });

    it('scales with the real offset', async () => {
      const rows = await mine({ corridorWidthMeters: 20_000 });
      const oneKm = rows.find((r) => r.name.endsWith('Dist1km'))?.distanceFromRouteMeters ?? 0;
      const threeKm = rows.find((r) => r.name.endsWith('Dist3km'))?.distanceFromRouteMeters ?? 0;

      expect(threeKm).toBeGreaterThan(oneKm * 2);
      expect(threeKm).toBeLessThan(4_000);
    });

    it('measures distance to the line, not to the endpoints', async () => {
      const rows = await mine({ corridorWidthMeters: 20_000 });
      const midpoint = rows.find((r) => r.name.endsWith('Dist1km'));

      /* Straight-line distance from this Place to the origin is ~24 km. Measuring
         against the endpoints instead of the LineString would report that (§14). */
      expect(midpoint?.distanceFromRouteMeters).toBeLessThan(2_000);
    });

    it('returns the nearest to the line first', async () => {
      const rows = await mine({ corridorWidthMeters: 20_000 });
      const distances = rows.map((r) => r.distanceFromRouteMeters);

      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    });
  });

  describe('route progress (§15, §70)', () => {
    beforeAll(async () => {
      /* The route runs almost due north from −8.0631 to −7.115, so latitude maps
         nearly linearly onto progress. */
      await seed({ name: 'Prog10', latitude: -7.968, longitude: -34.862 });
      await seed({ name: 'Prog50', latitude: -7.589, longitude: -34.842 });
      await seed({ name: 'Prog90', latitude: -7.21, longitude: -34.862 });
    });

    const progressOf = async (name: string): Promise<number> => {
      const rows = await mine({ corridorWidthMeters: 20_000 });
      return rows.find((r) => r.name.endsWith(name))?.routeProgress ?? -1;
    };

    it('places an early Place near the start', async () => {
      const progress = await progressOf('Prog10');
      expect(progress).toBeGreaterThan(0.03);
      expect(progress).toBeLessThan(0.2);
    });

    it('places a mid-route Place near the middle', async () => {
      const progress = await progressOf('Prog50');
      expect(progress).toBeGreaterThan(0.4);
      expect(progress).toBeLessThan(0.6);
    });

    it('places a late Place near the end', async () => {
      const progress = await progressOf('Prog90');
      expect(progress).toBeGreaterThan(0.8);
      expect(progress).toBeLessThan(0.97);
    });

    it('is monotonic along the route', async () => {
      const [early, middle, late] = await Promise.all([
        progressOf('Prog10'),
        progressOf('Prog50'),
        progressOf('Prog90'),
      ]);

      expect(early).toBeLessThan(middle);
      expect(middle).toBeLessThan(late);
    });

    it('stays within [0, 1] for every candidate', async () => {
      const rows = await mine({ corridorWidthMeters: 20_000 });

      for (const row of rows) {
        expect(row.routeProgress).toBeGreaterThanOrEqual(0);
        expect(row.routeProgress).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('query strategy (§12, §46)', () => {
    /**
     * The plan with sequential scans disabled.
     *
     * Whether the planner *chooses* the index depends on table size and cost
     * estimates, and asserting a choice would make this test a hostage to the
     * planner. What must not regress is whether the index can serve the predicate at
     * all, which is exactly what disabling seqscan asks.
     */
    const planFor = async (statement: ReturnType<typeof sql>): Promise<string> =>
      database.db.transaction(async (tx) => {
        /* Inside a transaction, so `SET LOCAL` actually applies and cannot leak onto
           a pooled connection afterwards. */
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const result = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN (COSTS OFF) ${statement}`,
        );
        return result.rows.map((r) => r['QUERY PLAN']).join('\n');
      });

    it('reaches the GIST index through ST_DWithin against the line', async () => {
      const plan = await planFor(sql`
        SELECT p.id FROM places p
         WHERE p.status = 'ACTIVE'
           AND ST_DWithin(
                 p.location,
                 ST_SetSRID(ST_GeomFromGeoJSON(${route}), 4326)::geography,
                 5000
               )
      `);

      expect(plan).toContain('places_location_gist_idx');
    });

    it('returns the same Places as buffering the corridor would', async () => {
      /* Both forms are correct; `ST_DWithin` is chosen because it is measurably
         cheaper and needs no intermediate polygon (ADR-0014). This asserts they
         genuinely agree, so the cheaper one is not quietly a different question. */
      const viaDWithin = await database.db.execute<{ id: string }>(sql`
        SELECT p.id FROM places p
         WHERE p.status = 'ACTIVE'
           AND p.name LIKE ${`${suite}%`}
           AND ST_DWithin(
                 p.location, ST_SetSRID(ST_GeomFromGeoJSON(${route}), 4326)::geography, 5000)
         ORDER BY p.id
      `);

      const viaBuffer = await database.db.execute<{ id: string }>(sql`
        WITH corridor AS (
          SELECT ST_Buffer(
                   ST_SetSRID(ST_GeomFromGeoJSON(${route}), 4326)::geography, 5000) AS geog
        )
        SELECT p.id FROM places p, corridor c
         WHERE p.status = 'ACTIVE'
           AND p.name LIKE ${`${suite}%`}
           AND ST_Intersects(p.location, c.geog)
         ORDER BY p.id
      `);

      expect(viaDWithin.rows.map((r) => r.id)).toEqual(viaBuffer.rows.map((r) => r.id));
    });

    it('binds category ids as parameters rather than interpolating them', async () => {
      /* A category id shaped like SQL must be data, not syntax (§82). */
      const rows = await mine({ categoryIds: ["LANDMARK'; DROP TABLE places; --"] });

      expect(rows).toEqual([]);
      const survived = await database.db.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM places`,
      );
      expect(Number(survived.rows[0]?.count)).toBeGreaterThan(0);
    });
  });
});
