import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import type { BoundingBox, Coordinates } from '../domain/coordinates.js';
import type {
  PlaceDetail,
  PlaceListItem,
  PlaceMapItem,
  PlaceProvenance,
  PlaceStatus,
} from '../domain/place.js';

/**
 * Spatial persistence for Places.
 *
 * Queries are written as explicit SQL rather than through the query builder. That is
 * the deliberate position of ADR-0004 and §31: `ST_DWithin`, `ST_MakeEnvelope` and
 * the `geography`/`geometry` casts are the *interesting* part of these statements,
 * and burying them in a builder would make the index usage harder to see and harder
 * to review. Every value is still a bound parameter — nothing is concatenated.
 */

/** Row shapes carry an index signature because `db.execute<T>` requires one. */
interface PlaceRow {
  [column: string]: unknown;
  id: string;
  name: string;
  category_id: string;
  latitude: number;
  longitude: number;
}

interface PlaceListRow extends PlaceRow {
  description: string | null;
  distance_metres: number | null;
}

interface PlaceDetailRow extends PlaceListRow {
  provenance: PlaceProvenance;
  status: PlaceStatus;
  /**
   * Timestamps arrive as strings.
   *
   * The query-builder path maps column types back to JS values; `db.execute` returns
   * what the driver produced, and for `timestamptz` on this path that is a string.
   * Declaring these as `Date` compiled fine and failed at runtime — the type was a
   * claim TypeScript had no way to check, so they are typed honestly and converted.
   */
  created_at: string | Date;
  updated_at: string | Date;
  contributor_username: string | null;
  contributor_display_name: string | null;
}

export interface CreatePlaceRecord {
  name: string;
  categoryId: string;
  coordinates: Coordinates;
  description: string | null;
  provenance: PlaceProvenance;
  createdByUserId: string | null;
}

export interface NearbyQuery {
  coordinates: Coordinates;
  radiusMetres: number;
  categoryId?: string | undefined;
  limit: number;
  offset: number;
}

export interface SearchQuery {
  term: string;
  categoryId?: string | undefined;
  /** Optional reference point, so results can carry a distance and sort sensibly. */
  near?: Coordinates | undefined;
  limit: number;
  offset: number;
}

@Injectable()
export class PlaceRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Builds a `geography` point from a validated pair.
   *
   * Argument order is longitude-then-latitude: `ST_MakePoint` takes X before Y, and
   * getting it backwards is the single most common PostGIS mistake. Callers pass a
   * named `Coordinates`, so the swap happens once, here.
   */
  private static point(coordinates: Coordinates): SQL {
    return sql`ST_SetSRID(ST_MakePoint(${coordinates.longitude}, ${coordinates.latitude}), 4326)::geography`;
  }

  /** Latitude and longitude in degrees, for the wire (§20). */
  private static readonly coordinateColumns = sql`
    ST_Y(p.location::geometry) AS latitude,
    ST_X(p.location::geometry) AS longitude
  `;

  async create(record: CreatePlaceRecord): Promise<string> {
    const result = await this.db.execute<{ id: string }>(sql`
      INSERT INTO places (name, category_id, location, description, provenance, created_by_user_id)
      VALUES (
        ${record.name},
        ${record.categoryId},
        ${PlaceRepository.point(record.coordinates)},
        ${record.description},
        ${record.provenance},
        ${record.createdByUserId}
      )
      RETURNING id
    `);

    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('Place insert returned no row');
    return id;
  }

  async findDetailById(id: string): Promise<PlaceDetail | undefined> {
    const result = await this.db.execute<PlaceDetailRow>(sql`
      SELECT p.id, p.name, p.category_id, p.description, p.provenance, p.status,
             p.created_at, p.updated_at,
             ${PlaceRepository.coordinateColumns},
             NULL::double precision AS distance_metres,
             prof.username     AS contributor_username,
             prof.display_name AS contributor_display_name
        FROM places p
        LEFT JOIN user_profiles prof ON prof.user_id = p.created_by_user_id
       WHERE p.id = ${id}
         AND p.status = 'ACTIVE'
       LIMIT 1
    `);

    const row = result.rows[0];
    if (row === undefined) return undefined;

    return {
      id: row.id,
      name: row.name,
      categoryId: row.category_id,
      latitude: row.latitude,
      longitude: row.longitude,
      description: row.description,
      provenance: row.provenance,
      status: row.status,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
      contributor:
        row.contributor_username === null || row.contributor_display_name === null
          ? null
          : {
              username: row.contributor_username,
              displayName: row.contributor_display_name,
            },
    };
  }

  /**
   * Places within a radius, nearest first (§17).
   *
   * `ST_DWithin` on a `geography` column is the index-using form: the planner can
   * satisfy it from `places_location_gist_idx`, whereas `ST_Distance(...) < r` would
   * force a sequential scan and compute a spheroid distance for every row.
   */
  async findNearby(query: NearbyQuery): Promise<PlaceListItem[]> {
    const origin = PlaceRepository.point(query.coordinates);

    const result = await this.db.execute<PlaceListRow>(sql`
      SELECT p.id, p.name, p.category_id, p.description,
             ${PlaceRepository.coordinateColumns},
             ST_Distance(p.location, ${origin}) AS distance_metres
        FROM places p
       WHERE p.status = 'ACTIVE'
         AND ST_DWithin(p.location, ${origin}, ${query.radiusMetres})
         ${categoryFilter(query.categoryId)}
       ORDER BY p.location <-> ${origin}
       LIMIT ${query.limit} OFFSET ${query.offset}
    `);

    return result.rows.map(toListItem);
  }

  /**
   * Places inside a viewport (§18) — the map's primary query.
   *
   * The envelope is cast to `geography` so the `&&` operator compares like with like
   * and the GIST index on `location` can answer it. Casting the *column* the other
   * way (`p.location::geometry && envelope`) is the obvious-looking form and it
   * silently disables the index: measured at 40k rows,
   *
   *   location::geometry && envelope          →  Seq Scan,           23.5 ms
   *   location && envelope::geography         →  Bitmap Index Scan,   0.8 ms
   *   ST_Intersects(location, envelope::geog) →  Index Scan,         27.5 ms
   *
   * `&&` is a bounding-box overlap rather than an exact intersection, so a few
   * markers just outside the box can come back. For deciding what to draw that is
   * harmless — arguably better, since a marker at the edge stays visible while
   * panning — and it is what makes the query thirty times cheaper.
   */
  async findInBoundingBox(box: BoundingBox, limit: number): Promise<PlaceMapItem[]> {
    const result = await this.db.execute<PlaceRow>(sql`
      SELECT p.id, p.name, p.category_id,
             ${PlaceRepository.coordinateColumns}
        FROM places p
       WHERE p.status = 'ACTIVE'
         AND p.location && ST_MakeEnvelope(
               ${box.west}, ${box.south}, ${box.east}, ${box.north}, 4326)::geography
       ORDER BY p.id
       LIMIT ${limit}
    `);

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      categoryId: row.category_id,
      latitude: row.latitude,
      longitude: row.longitude,
    }));
  }

  /**
   * Name search (§22).
   *
   * Matches on `search_text`, the generated accent- and case-folded column, so
   * "sao paulo" finds "São Paulo".
   *
   * `ILIKE '%…%'` is the predicate because `gin_trgm_ops` indexes it directly. An
   * earlier version also OR-ed in the `%` similarity operator for typo tolerance;
   * measured at 40k rows the OR made the planner abandon the index entirely, so
   * similarity now ranks results in ORDER BY without gating them in WHERE. Genuine
   * fuzzy matching is future work, not something to pay a sequential scan for.
   */
  async search(query: SearchQuery): Promise<PlaceListItem[]> {
    const folded = sql`trilha_immutable_unaccent(lower(${query.term}))`;
    const origin = query.near === undefined ? null : PlaceRepository.point(query.near);

    const result = await this.db.execute<PlaceListRow>(sql`
      SELECT p.id, p.name, p.category_id, p.description,
             ${PlaceRepository.coordinateColumns},
             ${origin === null ? sql`NULL::double precision` : sql`ST_Distance(p.location, ${origin})`} AS distance_metres
        FROM places p
       WHERE p.status = 'ACTIVE'
         AND p.search_text ILIKE '%' || ${folded} || '%'
         ${categoryFilter(query.categoryId)}
       ORDER BY similarity(p.search_text, ${folded}) DESC,
                ${origin === null ? sql`p.name` : sql`p.location <-> ${origin}`}
       LIMIT ${query.limit} OFFSET ${query.offset}
    `);

    return result.rows.map(toListItem);
  }

  /**
   * Existing Places that a submission might duplicate (§16).
   *
   * Same category, similar name, close by. Deliberately a *signal*, not a block:
   * "Restaurante Central" exists in many cities, and two of them are not a duplicate.
   * The caller surfaces these for a human to judge.
   */
  async findPossibleDuplicates(params: {
    name: string;
    categoryId: string;
    coordinates: Coordinates;
    radiusMetres: number;
    limit: number;
  }): Promise<PlaceListItem[]> {
    const origin = PlaceRepository.point(params.coordinates);
    const folded = sql`trilha_immutable_unaccent(lower(${params.name}))`;

    const result = await this.db.execute<PlaceListRow>(sql`
      SELECT p.id, p.name, p.category_id, p.description,
             ${PlaceRepository.coordinateColumns},
             ST_Distance(p.location, ${origin}) AS distance_metres
        FROM places p
       WHERE p.status = 'ACTIVE'
         AND p.category_id = ${params.categoryId}
         AND ST_DWithin(p.location, ${origin}, ${params.radiusMetres})
         AND similarity(p.search_text, ${folded}) > 0.4
       ORDER BY similarity(p.search_text, ${folded}) DESC
       LIMIT ${params.limit}
    `);

    return result.rows.map(toListItem);
  }

  async categoryExists(categoryId: string): Promise<boolean> {
    const result = await this.db.execute<{ found: boolean }>(
      sql`SELECT EXISTS(SELECT 1 FROM place_categories WHERE id = ${categoryId} AND is_active) AS found`,
    );
    return result.rows[0]?.found === true;
  }

  async listCategories(): Promise<{ id: string; label: string }[]> {
    const result = await this.db.execute<{ id: string; label: string }>(
      sql`SELECT id, label FROM place_categories WHERE is_active ORDER BY sort_order, label`,
    );
    return result.rows;
  }
}

/** Optional category predicate, as a parameterised fragment. */
function categoryFilter(categoryId: string | undefined): SQL {
  return categoryId === undefined ? sql`` : sql`AND p.category_id = ${categoryId}`;
}

/** Normalises a driver timestamp, whichever form it arrived in. */
function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function toListItem(row: PlaceListRow): PlaceListItem {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    latitude: row.latitude,
    longitude: row.longitude,
    description: row.description,
    distanceMetres: row.distance_metres === null ? null : Math.round(row.distance_metres),
  };
}
