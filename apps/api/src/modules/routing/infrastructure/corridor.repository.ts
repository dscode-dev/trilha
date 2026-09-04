import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { InvalidRouteGeometryError } from '../domain/routing-errors.js';
import { parseLineString, type RouteCorridor, type RouteGeometry } from '../domain/route.js';

/**
 * Derives the route corridor in PostGIS (§18, §20).
 *
 * **The buffer is taken on `geography`, not on `geometry`.** This is the whole
 * subtlety of the operation. `ST_Buffer` on a 4326 *geometry* interprets its distance
 * argument in **degrees**, so the natural-looking `ST_Buffer(line, 5000)` asks for a
 * 5,000-degree buffer. Measured against a 105 km Recife→João Pessoa line:
 *
 *   ST_Buffer(line, 5000)              → 221,122,129 km²  (and a coercion notice)
 *   ST_Buffer(line::geography, 5000)   →         1,128 km²
 *
 * The second is right: 105 km of route at 5 km either side is ≈1,050 km² plus end
 * caps. The first is a quarter of the Earth's surface. Nothing about the wrong form
 * raises an error, which is precisely why it is worth spelling out here.
 *
 * PostGIS implements the geography buffer by projecting to an appropriate planar
 * system, buffering, and projecting back — so the result is accurate at regional
 * scale without Trilha choosing a UTM zone.
 */
@Injectable()
export class CorridorRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Builds the corridor around [geometry] at [widthMeters] either side.
   *
   * `simplifyToleranceMeters` thins the *input line only*, and only for this
   * computation: a full-overview route can carry thousands of vertices, and buffering
   * each one produces a polygon far more detailed than any containment test needs.
   * The route's own geometry is never simplified — that is what gets drawn (§62).
   */
  async buildCorridor(
    geometry: RouteGeometry,
    widthMeters: number,
    simplifyToleranceMeters = 25,
  ): Promise<RouteCorridor> {
    /* Validated here rather than assumed: this repository is exported for PR-04, and
       PostGIS would happily buffer a single-position line into a circle instead of
       reporting the problem. */
    const geoJson = JSON.stringify(parseLineString(geometry));

    const result = await this.database.db.execute<{ corridor: string | null }>(sql`
      WITH line AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geoJson}), 4326) AS geom
      ),
      thinned AS (
        /* Simplification is in degrees, so the metre tolerance is converted at this
           latitude. Preserves topology, so the line cannot self-intersect. */
        SELECT ST_SimplifyPreserveTopology(
                 geom,
                 ${simplifyToleranceMeters}::double precision / 111320.0
               ) AS geom
          FROM line
      )
      SELECT ST_AsGeoJSON(
               ST_Buffer(geom::geography, ${widthMeters})::geometry
             ) AS corridor
        FROM thinned
    `);

    const corridor = result.rows[0]?.corridor;
    if (corridor === null || corridor === undefined) {
      throw new InvalidRouteGeometryError('Could not derive a corridor from the route geometry');
    }

    return {
      widthMeters,
      geometry: JSON.parse(corridor) as unknown,
    };
  }

  /**
   * Whether a point lies within [widthMeters] of the route.
   *
   * `ST_DWithin` on geography rather than a containment test against the buffered
   * polygon: same answer, no intermediate geometry, and it is the form PR-04 will use
   * against the spatial index on `places.location`.
   */
  async isWithinCorridor(
    geometry: RouteGeometry,
    widthMeters: number,
    point: { latitude: number; longitude: number },
  ): Promise<boolean> {
    const result = await this.database.db.execute<{ within: boolean }>(sql`
      SELECT ST_DWithin(
               ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(parseLineString(geometry))}), 4326)::geography,
               ST_SetSRID(ST_MakePoint(${point.longitude}, ${point.latitude}), 4326)::geography,
               ${widthMeters}
             ) AS within
    `);

    return result.rows[0]?.within === true;
  }

  /**
   * Length of the route along the ground, in metres.
   *
   * Used to sanity-check what the provider claimed: a distance that disagrees wildly
   * with its own geometry means the two describe different journeys.
   */
  async geodesicLengthMeters(geometry: RouteGeometry): Promise<number> {
    const result = await this.database.db.execute<{ length_m: number }>(sql`
      SELECT ST_Length(
               ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(parseLineString(geometry))}), 4326)::geography
             ) AS length_m
    `);

    return result.rows[0]?.length_m ?? 0;
  }
}
