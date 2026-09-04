import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { CorridorRepository } from '../../src/modules/routing/infrastructure/corridor.repository.js';
import type { RouteGeometry } from '../../src/modules/routing/domain/route.js';

/**
 * Corridor generation against real PostGIS (§53, §84).
 *
 * Independent of any routing provider: the geometry is a fixed LineString, so these
 * assertions are about PostGIS and Trilha's buffering strategy, and they hold whether
 * or not an upstream credential exists.
 */
describe('Route corridor (PostGIS)', () => {
  let app: INestApplication;
  let corridors: CorridorRepository;

  /**
   * A simplified BR-101 line from central Recife to João Pessoa, ~105 km.
   * Real coordinates, so distance assertions mean something.
   */
  const recifeToJoaoPessoa: RouteGeometry = {
    type: 'LineString',
    coordinates: [
      [-34.8711, -8.0631],
      [-34.86, -7.98],
      [-34.85, -7.85],
      [-34.84, -7.6],
      [-34.85, -7.4],
      [-34.8631, -7.115],
    ],
  };

  /** ~2 km inside central Recife. */
  const shortUrban: RouteGeometry = {
    type: 'LineString',
    coordinates: [
      [-34.8711, -8.0631],
      [-34.875, -8.07],
      [-34.88, -8.075],
    ],
  };

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    corridors = app.get(CorridorRepository);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  describe('geometry length', () => {
    it('measures the fixture at its real ground length', async () => {
      const metres = await corridors.geodesicLengthMeters(recifeToJoaoPessoa);

      /* Recife → João Pessoa is ~105 km. A geometry length in degrees would be
         ~0.95 — three orders of magnitude out. */
      expect(metres).toBeGreaterThan(100_000);
      expect(metres).toBeLessThan(115_000);
    });

    it('measures a short urban line in metres', async () => {
      const metres = await corridors.geodesicLengthMeters(shortUrban);

      expect(metres).toBeGreaterThan(1_000);
      expect(metres).toBeLessThan(3_000);
    });
  });

  describe('containment (§21)', () => {
    /* A point on the BR-101 corridor, roughly midway. */
    const onRoute = { latitude: -7.85, longitude: -34.85 };
    /* ~60 km inland of the same latitude — well outside any sane corridor. */
    const farInland = { latitude: -7.85, longitude: -35.4 };

    it('includes a place beside the route', async () => {
      expect(await corridors.isWithinCorridor(recifeToJoaoPessoa, 5_000, onRoute)).toBe(true);
    });

    it('excludes a place far from the route', async () => {
      expect(await corridors.isWithinCorridor(recifeToJoaoPessoa, 5_000, farInland)).toBe(false);
    });

    it('respects the width: a point outside 2 km can be inside 20 km', async () => {
      /* ~8 km east of the line. */
      const eightKmAway = { latitude: -7.85, longitude: -34.78 };

      expect(await corridors.isWithinCorridor(recifeToJoaoPessoa, 2_000, eightKmAway)).toBe(false);
      expect(await corridors.isWithinCorridor(recifeToJoaoPessoa, 20_000, eightKmAway)).toBe(true);
    });

    it('behaves sanely at the width boundary', async () => {
      /* ~0.045° ≈ 5.0 km east of the line at this latitude. */
      const nearBoundary = { latitude: -7.85, longitude: -34.805 };

      expect(await corridors.isWithinCorridor(recifeToJoaoPessoa, 10_000, nearBoundary)).toBe(true);
      expect(await corridors.isWithinCorridor(recifeToJoaoPessoa, 1_000, nearBoundary)).toBe(false);
    });

    it('includes the endpoints themselves', async () => {
      const origin = { latitude: -8.0631, longitude: -34.8711 };
      const destination = { latitude: -7.115, longitude: -34.8631 };

      expect(await corridors.isWithinCorridor(recifeToJoaoPessoa, 1_000, origin)).toBe(true);
      expect(await corridors.isWithinCorridor(recifeToJoaoPessoa, 1_000, destination)).toBe(true);
    });
  });

  describe('buffer geometry (§20)', () => {
    it('produces a polygon around the route', async () => {
      const corridor = await corridors.buildCorridor(recifeToJoaoPessoa, 5_000);
      const geometry = corridor.geometry as { type: string; coordinates: unknown };

      expect(['Polygon', 'MultiPolygon']).toContain(geometry.type);
      expect(corridor.widthMeters).toBe(5_000);
    });

    /**
     * The distinction this whole design turns on.
     *
     * `ST_Buffer` on a 4326 *geometry* reads its argument as degrees, so the
     * natural-looking `ST_Buffer(line, 5000)` asks for a 5,000-degree buffer and
     * silently returns roughly a quarter of the Earth. Buffering on *geography*
     * reads metres. Measured on this fixture: 221,122,129 km² versus 1,128 km².
     */
    it('buffers in metres, not degrees', async () => {
      const corridor = await corridors.buildCorridor(recifeToJoaoPessoa, 5_000);

      const areaKm2 = await polygonAreaKm2(app, corridor.geometry);

      /* ~105 km of route at 5 km either side ≈ 1,050 km², plus rounded end caps. */
      expect(areaKm2).toBeGreaterThan(900);
      expect(areaKm2).toBeLessThan(1_400);
    });

    it('scales with the requested width', async () => {
      const narrow = await corridors.buildCorridor(recifeToJoaoPessoa, 2_000);
      const wide = await corridors.buildCorridor(recifeToJoaoPessoa, 10_000);

      const narrowArea = await polygonAreaKm2(app, narrow.geometry);
      const wideArea = await polygonAreaKm2(app, wide.geometry);

      expect(wideArea).toBeGreaterThan(narrowArea * 3);
    });

    it('stays compact enough to transmit', async () => {
      const corridor = await corridors.buildCorridor(recifeToJoaoPessoa, 5_000);

      /* A buffer of a simplified line is tens of vertices, not thousands — which is
         what makes returning it viable at all (§47, §62). */
      const serialised = JSON.stringify(corridor.geometry);
      expect(serialised.length).toBeLessThan(60_000);
    });

    it('handles a short urban route', async () => {
      const corridor = await corridors.buildCorridor(shortUrban, 1_000);
      const areaKm2 = await polygonAreaKm2(app, corridor.geometry);

      expect(areaKm2).toBeGreaterThan(3);
      expect(areaKm2).toBeLessThan(20);
    });

    it('rejects a geometry PostGIS cannot read', async () => {
      const malformed = {
        type: 'LineString',
        coordinates: [[-34.87, -8.06]],
      } as unknown as RouteGeometry;

      await expect(corridors.buildCorridor(malformed, 5_000)).rejects.toThrow();
    });
  });

  describe('performance (§61)', () => {
    it('generates a corridor for a 105 km route quickly', async () => {
      const startedAt = performance.now();
      await corridors.buildCorridor(recifeToJoaoPessoa, 5_000);
      const elapsed = performance.now() - startedAt;

      /* Generous: this guards against an accidental full-precision buffer over
         thousands of vertices, not against normal variance. */
      expect(elapsed).toBeLessThan(2_000);
    });

    it('handles a dense geometry without blowing up', async () => {
      /* 2,000 positions, the order of magnitude a full-overview intercity route
         returns. */
      const dense: RouteGeometry = {
        type: 'LineString',
        coordinates: Array.from({ length: 2_000 }, (_, i) => {
          const t = i / 1_999;
          return [-34.8711 + t * 0.008, -8.0631 + t * 0.948] as [number, number];
        }),
      };

      const startedAt = performance.now();
      const corridor = await corridors.buildCorridor(dense, 5_000);
      const elapsed = performance.now() - startedAt;

      expect(corridor.geometry).toBeDefined();
      expect(elapsed).toBeLessThan(5_000);
    });
  });
});

/** Area of a GeoJSON polygon in km², measured on the spheroid. */
async function polygonAreaKm2(app: INestApplication, geometry: unknown): Promise<number> {
  const { DatabaseService } = await import('../../src/infrastructure/database/database.service.js');
  const { sql } = await import('drizzle-orm');

  const database = app.get(DatabaseService);
  const result = await database.db.execute<{ area_km2: number }>(sql`
    SELECT ST_Area(
             ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)::geography
           ) / 1000000 AS area_km2
  `);

  return result.rows[0]?.area_km2 ?? 0;
}
