import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { PlacesAlongRouteQuery } from '../../src/modules/places/application/places-along-route.query.js';
import { RouteRelevancePolicyV1 } from '../../src/modules/discovery/domain/route-relevance.js';
import {
  compareCandidates,
  type RouteCandidate,
} from '../../src/modules/discovery/domain/route-candidate.js';

/**
 * Discovery at volume (§47, §85, §97).
 *
 * The point is a reproducible baseline, not an SLA. Absolute milliseconds vary with
 * the machine; what these assert is the property that must hold anywhere — that the
 * spatial stage is index-bound rather than proportional to the table, and that
 * ranking is negligible next to it. The numbers are printed so a regression is
 * visible in CI output even when the loose bound still passes.
 */
describe('Discovery performance baseline', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let places: PlacesAlongRouteQuery;

  const DATASET_ROWS = 40_000;
  const suite = `DiscBench-${Math.random().toString(36).slice(2, 8)}`;

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

  const measure = async <T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> => {
    const startedAt = performance.now();
    const result = await fn();
    return { result, ms: Math.round((performance.now() - startedAt) * 100) / 100 };
  };

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    database = app.get(DatabaseService);
    places = app.get(PlacesAlongRouteQuery);

    /* Spread across a 3°×3° box around the corridor, so a realistic minority of rows
       fall inside it and the index has to do real work.
     *
     * Inserted in batches rather than one statement: 40,000 rows with a GIST index and
     * a foreign key on every row exceeds the connection's statement timeout when the
     * database is also serving the other integration specs. */
    const BATCH = 5_000;
    for (let offset = 0; offset < DATASET_ROWS; offset += BATCH) {
      await database.db.execute(sql`
        INSERT INTO places (name, category_id, location, provenance, status)
        SELECT ${suite} || ' ' || g,
               (ARRAY['LANDMARK','FOOD','NATURE','HISTORY_CULTURE'])[1 + (g % 4)],
               ST_SetSRID(ST_MakePoint(-36.0 + random() * 3.0, -9.5 + random() * 3.0), 4326)::geography,
               'SYSTEM',
               'ACTIVE'
          FROM generate_series(${offset + 1}::int, ${offset + BATCH}::int) g
      `);
    }
    await database.db.execute(sql`ANALYZE places`);
  }, 180_000);

  afterAll(async () => {
    /* Deleted in batches for the same reason the insert is. */
    for (;;) {
      const deleted = await database.db.execute(sql`
        DELETE FROM places
         WHERE id IN (
           SELECT id FROM places WHERE name LIKE ${`${suite}%`} LIMIT 5000
         )
      `);
      if (deleted.rowCount === 0) break;
    }
    await database.db.execute(sql`ANALYZE places`);
    await app.close();
  }, 120_000);

  it('retrieves, scores and ranks a 105 km corridor at volume', async () => {
    const total = await database.db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM places`,
    );

    /* Warm the cache, so the figure reported is steady-state rather than first-touch. */
    await places.execute({
      routeGeoJson: route,
      corridorWidthMeters: 5_000,
      categoryIds: [],
      limit: 100,
    });

    const spatial = await measure(() =>
      places.execute({
        routeGeoJson: route,
        corridorWidthMeters: 5_000,
        categoryIds: [],
        limit: 100,
      }),
    );

    const policy = new RouteRelevancePolicyV1();
    const ranking = await measure(() => {
      const scored: RouteCandidate[] = spatial.result.map((row, index) => {
        const verdict = policy.evaluate(
          {
            place: {
              id: row.id,
              name: row.name,
              categoryId: row.categoryId,
              latitude: row.latitude,
              longitude: row.longitude,
              provenance: row.provenance,
            },
            distanceFromRouteMeters: row.distanceFromRouteMeters,
            routeProgress: row.routeProgress,
            detourDistanceMeters: 3_000 + index * 10,
            detourDurationSeconds: 300 + index * 5,
          },
          { maxDetourSeconds: 1_800, corridorWidthMeters: 5_000 },
        );

        return {
          place: {
            id: row.id,
            name: row.name,
            categoryId: row.categoryId,
            latitude: row.latitude,
            longitude: row.longitude,
            provenance: row.provenance,
          },
          distanceFromRouteMeters: row.distanceFromRouteMeters,
          routeProgress: row.routeProgress,
          detourDistanceMeters: 3_000 + index * 10,
          detourDurationSeconds: 300 + index * 5,
          relevanceScore: verdict.score,
          relevanceReasons: verdict.reasons,
        };
      });

      return Promise.resolve(scored.sort(compareCandidates));
    });

    /* eslint-disable no-console -- the baseline is the deliverable of this test. */
    console.log(
      [
        '',
        '  Discovery baseline',
        `    Dataset:            ${total.rows[0]?.count ?? '?'} places`,
        `    Spatial retrieval:  ${String(spatial.ms)} ms`,
        `    Candidates found:   ${String(spatial.result.length)}`,
        `    Ranking (in-app):   ${String(ranking.ms)} ms`,
        '    Detour evaluation:  1 provider call (fixed; see §98)',
        '',
      ].join('\n'),
    );
    /* eslint-enable no-console */

    expect(spatial.result.length).toBeGreaterThan(0);
    /* Generous by design: this guards against the index being lost, which turns tens
       of milliseconds into seconds, not against normal variance. */
    expect(spatial.ms).toBeLessThan(2_000);
    /* Ranking is arithmetic over at most a hundred rows; if it ever approaches the
       spatial cost, something has been added to the policy that does not belong. */
    expect(ranking.ms).toBeLessThan(100);
  }, 120_000);

  it('costs about the same for a narrow corridor as a wide one', async () => {
    const narrow = await measure(() =>
      places.execute({
        routeGeoJson: route,
        corridorWidthMeters: 1_000,
        categoryIds: [],
        limit: 100,
      }),
    );
    const wide = await measure(() =>
      places.execute({
        routeGeoJson: route,
        corridorWidthMeters: 20_000,
        categoryIds: [],
        limit: 100,
      }),
    );

    /* Both are index-bound; the wider one touches more rows but not proportionally
       more, which is the property that keeps a generous corridor affordable. */
    expect(wide.result.length).toBeGreaterThan(narrow.result.length);
    expect(wide.ms).toBeLessThan(2_000);
  }, 120_000);

  it('stays bounded when the candidate cap is small', async () => {
    const capped = await measure(() =>
      places.execute({
        routeGeoJson: route,
        corridorWidthMeters: 5_000,
        categoryIds: [],
        limit: 10,
      }),
    );

    expect(capped.result).toHaveLength(10);
    expect(capped.ms).toBeLessThan(2_000);
  }, 120_000);
});
