import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import type { RouteGeometry } from '../../routing/domain/route.js';
import {
  type Trail,
  type TrailBaseRoute,
  type TrailEndpoint,
  type TrailRouteSnapshot,
  type TrailStatus,
  type TrailStop,
  type TrailStopSource,
  type TrailSummary,
} from '../domain/trail.js';

/**
 * Persistence for Trails.
 *
 * Explicit SQL rather than the query builder, per ADR-0004: the interesting parts of
 * these statements — the compare-and-set on `revision`, the `ST_AsGeoJSON` casts, the
 * position rewrite — are exactly what a reviewer needs to see. Every value is a bound
 * parameter; nothing is concatenated.
 *
 * **No external call ever happens inside a transaction opened here** (§29, §82).
 * Methods take an already-computed snapshot and write it; the provider call that
 * produced it happened before the transaction was opened.
 */

interface TrailRow {
  [column: string]: unknown;
  id: string;
  owner_user_id: string;
  status: TrailStatus;
  origin_latitude: number;
  origin_longitude: number;
  origin_place_id: string | null;
  origin_label: string | null;
  destination_latitude: number;
  destination_longitude: number;
  destination_place_id: string | null;
  destination_label: string | null;
  revision: number;
  route_geometry: string | null;
  route_north: number | null;
  route_south: number | null;
  route_east: number | null;
  route_west: number | null;
  route_distance_meters: number | null;
  route_duration_seconds: number | null;
  route_provider: string | null;
  route_calculated_at: string | Date | null;
  route_revision: number | null;
  base_distance_meters: number | null;
  base_duration_seconds: number | null;
  base_calculated_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  finalized_at: string | Date | null;
}

interface TrailStopRow {
  [column: string]: unknown;
  id: string;
  place_id: string;
  position: number;
  source: TrailStopSource;
  place_name: string;
  place_category_id: string;
  place_latitude: number;
  place_longitude: number;
}

interface TrailSummaryRow {
  [column: string]: unknown;
  id: string;
  status: TrailStatus;
  origin_label: string | null;
  destination_label: string | null;
  stop_count: number;
  route_distance_meters: number | null;
  route_duration_seconds: number | null;
  revision: number;
  updated_at: string | Date;
}

export interface CreateTrailRecord {
  ownerUserId: string;
  origin: TrailEndpointInput;
  destination: TrailEndpointInput;
}

export interface TrailEndpointInput {
  latitude: number;
  longitude: number;
  placeId?: string | undefined;
  label?: string | undefined;
}

/** A computed route, ready to persist. The provider call already happened (§29). */
export interface RouteSnapshotRecord {
  geometry: RouteGeometry;
  distanceMeters: number;
  durationSeconds: number;
  provider: string;
}

export interface BaseRouteRecord {
  distanceMeters: number;
  durationSeconds: number;
}

/** One accepted mutation: a composition change plus the route that describes it. */
export interface TrailMutation {
  trailId: string;
  ownerUserId: string;
  expectedRevision: number;
  /** Applied inside the same transaction as the revision bump. */
  apply: (tx: TransactionLike) => Promise<void>;
  route: RouteSnapshotRecord;
  /** Recomputed only when the endpoints changed (ADR-0016). */
  baseRoute?: BaseRouteRecord | undefined;
  /** Endpoint replacement, for the one mutation that changes them. */
  endpoints?: { origin: TrailEndpointInput; destination: TrailEndpointInput } | undefined;
}

/**
 * The transaction handle Drizzle hands a callback.
 *
 * Derived from the driver's own signature rather than hand-declared: a structural
 * stand-in drifts silently the first time the ORM changes shape, and the mutation
 * bodies below run against the real thing.
 */
export type TransactionLike = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/**
 * Where positions are parked mid-reorder.
 *
 * Comfortably above `MAX_TRAIL_STOPS`, so a parked row can never be mistaken for a
 * real one by the second pass.
 */
const REORDER_OFFSET = 1_000;

@Injectable()
export class TrailRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** Coordinates as degrees, and the snapshot as GeoJSON, ready for the wire. */
  private static readonly trailColumns = sql`
    t.id, t.owner_user_id, t.status,
    ST_Y(t.origin_location::geometry)      AS origin_latitude,
    ST_X(t.origin_location::geometry)      AS origin_longitude,
    t.origin_place_id, t.origin_label,
    ST_Y(t.destination_location::geometry) AS destination_latitude,
    ST_X(t.destination_location::geometry) AS destination_longitude,
    t.destination_place_id, t.destination_label,
    t.revision,
    ST_AsGeoJSON(t.route_geometry)         AS route_geometry,
    /* Bounds are derived rather than stored: they are a pure function of the
       geometry, and a second copy is a second thing that can disagree with it. */
    ST_YMax(t.route_geometry)              AS route_north,
    ST_YMin(t.route_geometry)              AS route_south,
    ST_XMax(t.route_geometry)              AS route_east,
    ST_XMin(t.route_geometry)              AS route_west,
    t.route_distance_meters, t.route_duration_seconds,
    t.route_provider, t.route_calculated_at, t.route_revision,
    t.base_distance_meters, t.base_duration_seconds, t.base_calculated_at,
    t.created_at, t.updated_at, t.finalized_at
  `;

  private static point(latitude: number, longitude: number): SQL {
    /* ST_MakePoint takes X before Y; the swap happens once, here. */
    return sql`ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography`;
  }

  async create(record: CreateTrailRecord): Promise<string> {
    const result = await this.db.execute<{ id: string }>(sql`
      INSERT INTO trails (
        owner_user_id, origin_location, origin_place_id, origin_label,
        destination_location, destination_place_id, destination_label
      ) VALUES (
        ${record.ownerUserId},
        ${TrailRepository.point(record.origin.latitude, record.origin.longitude)},
        ${record.origin.placeId ?? null},
        ${record.origin.label ?? null},
        ${TrailRepository.point(record.destination.latitude, record.destination.longitude)},
        ${record.destination.placeId ?? null},
        ${record.destination.label ?? null}
      )
      RETURNING id
    `);

    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('Trail insert returned no id');
    return id;
  }

  /**
   * A Trail with its stops, scoped to its owner.
   *
   * Ownership is part of the WHERE clause rather than a check afterwards: a query that
   * cannot return another account's row is a stronger guarantee than one that returns
   * it and then remembers not to (§53).
   */
  async findByIdForOwner(trailId: string, ownerUserId: string): Promise<Trail | undefined> {
    const result = await this.db.execute<TrailRow>(sql`
      SELECT ${TrailRepository.trailColumns}
        FROM trails t
       WHERE t.id = ${trailId} AND t.owner_user_id = ${ownerUserId}
    `);

    const row = result.rows[0];
    if (row === undefined) return undefined;

    return toTrail(row, await this.findStops(trailId));
  }

  async findStops(trailId: string): Promise<TrailStop[]> {
    const result = await this.db.execute<TrailStopRow>(sql`
      SELECT s.id, s.place_id, s.position, s.source,
             p.name AS place_name, p.category_id AS place_category_id,
             ST_Y(p.location::geometry) AS place_latitude,
             ST_X(p.location::geometry) AS place_longitude
        FROM trail_stops s
        JOIN places p ON p.id = s.place_id
       WHERE s.trail_id = ${trailId}
       ORDER BY s.position ASC
    `);

    return result.rows.map(toStop);
  }

  /**
   * The owner's trails, most recently touched first (§42, §43).
   *
   * Keyset pagination on `(updated_at, id)` rather than OFFSET: a Trail edited during
   * paging would otherwise shift rows between pages, showing one twice and hiding
   * another. The composite index serves the ordering directly.
   */
  async listForOwner(params: {
    ownerUserId: string;
    limit: number;
    cursor?: { updatedAt: Date; id: string } | undefined;
    statuses?: readonly TrailStatus[] | undefined;
  }): Promise<TrailSummary[]> {
    const cursor = params.cursor;
    const keyset =
      cursor === undefined
        ? sql``
        : sql`AND (t.updated_at, t.id) < (${cursor.updatedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;

    const statuses = params.statuses ?? [];
    const statusFilter =
      statuses.length === 0
        ? sql``
        : sql`AND t.status IN (${sql.join(
            statuses.map((status) => sql`${status}`),
            sql`, `,
          )})`;

    const result = await this.db.execute<TrailSummaryRow>(sql`
      SELECT t.id, t.status, t.origin_label, t.destination_label,
             t.route_distance_meters, t.route_duration_seconds,
             t.revision, t.updated_at,
             (SELECT COUNT(*) FROM trail_stops s WHERE s.trail_id = t.id)::int AS stop_count
        FROM trails t
       WHERE t.owner_user_id = ${params.ownerUserId}
         ${statusFilter}
         ${keyset}
       ORDER BY t.updated_at DESC, t.id DESC
       LIMIT ${params.limit}
    `);

    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      originLabel: row.origin_label,
      destinationLabel: row.destination_label,
      stopCount: row.stop_count,
      distanceMeters: row.route_distance_meters,
      durationSeconds: row.route_duration_seconds,
      revision: row.revision,
      updatedAt: toDate(row.updated_at),
    }));
  }

  /**
   * Applies one mutation, or reports that someone got there first (§25, §90).
   *
   * **This method is the concurrency guarantee.** The revision check is a predicate on
   * the UPDATE itself, not a read followed by a write: two requests carrying the same
   * `expectedRevision` both reach the statement, exactly one matches a row, and the
   * other sees `rowCount === 0` and is told to reload. A `SELECT` then `UPDATE` would
   * let both pass the check and the second silently overwrite the first.
   *
   * Everything inside is local work. The route was computed before this was called
   * (§29, §82) — holding a transaction open across an HTTP call to Mapbox would pin a
   * connection for as long as the provider felt like taking.
   */
  async applyMutation(mutation: TrailMutation): Promise<Trail | undefined> {
    return this.db.transaction(async (tx) => {
      const endpoints = mutation.endpoints;
      const endpointColumns =
        endpoints === undefined
          ? sql``
          : sql`,
              origin_location = ${TrailRepository.point(endpoints.origin.latitude, endpoints.origin.longitude)},
              origin_place_id = ${endpoints.origin.placeId ?? null},
              origin_label = ${endpoints.origin.label ?? null},
              destination_location = ${TrailRepository.point(endpoints.destination.latitude, endpoints.destination.longitude)},
              destination_place_id = ${endpoints.destination.placeId ?? null},
              destination_label = ${endpoints.destination.label ?? null}`;

      const base = mutation.baseRoute;
      const baseColumns =
        base === undefined
          ? sql``
          : sql`,
              base_distance_meters = ${Math.round(base.distanceMeters)},
              base_duration_seconds = ${Math.round(base.durationSeconds)},
              base_calculated_at = now()`;

      const updated = await tx.execute<{ revision: number }>(sql`
        UPDATE trails t
           SET revision = t.revision + 1,
               updated_at = now(),
               route_geometry = ST_SetSRID(
                 ST_GeomFromGeoJSON(${JSON.stringify(mutation.route.geometry)}), 4326),
               route_distance_meters = ${Math.round(mutation.route.distanceMeters)},
               route_duration_seconds = ${Math.round(mutation.route.durationSeconds)},
               route_provider = ${mutation.route.provider},
               route_calculated_at = now(),
               route_revision = t.revision + 1,
               /* Editing a finished trail reopens it — "finished" describes the
                  current state, not a one-way door (§46). */
               status = CASE WHEN t.status = 'FINALIZED' THEN 'DRAFT' ELSE t.status END,
               finalized_at = CASE WHEN t.status = 'FINALIZED' THEN NULL ELSE t.finalized_at END
               ${endpointColumns}
               ${baseColumns}
         WHERE t.id = ${mutation.trailId}
           AND t.owner_user_id = ${mutation.ownerUserId}
           AND t.revision = ${mutation.expectedRevision}
        RETURNING t.revision
      `);

      /* Nothing matched: either the revision moved, or the trail is not this user's.
         The caller distinguishes those by re-reading; both are refusals, not writes. */
      if (updated.rowCount === 0) return undefined;

      await mutation.apply(tx);

      const result = await tx.execute<TrailRow>(sql`
        SELECT ${TrailRepository.trailColumns} FROM trails t WHERE t.id = ${mutation.trailId}
      `);
      const row = result.rows[0];
      if (row === undefined) return undefined;

      const stops = await tx.execute<TrailStopRow>(sql`
        SELECT s.id, s.place_id, s.position, s.source,
               p.name AS place_name, p.category_id AS place_category_id,
               ST_Y(p.location::geometry) AS place_latitude,
               ST_X(p.location::geometry) AS place_longitude
          FROM trail_stops s
          JOIN places p ON p.id = s.place_id
         WHERE s.trail_id = ${mutation.trailId}
         ORDER BY s.position ASC
      `);

      return toTrail(row, stops.rows.map(toStop));
    });
  }

  /* ---- Mutation bodies, run inside `applyMutation`'s transaction ------------ */

  /** Appends a stop at the end of the list. */
  static appendStop(params: {
    trailId: string;
    placeId: string;
    source: TrailStopSource;
  }): (tx: TransactionLike) => Promise<void> {
    return async (tx) => {
      await tx.execute(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        SELECT ${params.trailId}, ${params.placeId},
               COALESCE(MAX(s.position), 0) + 1, ${params.source}
          FROM trail_stops s
         WHERE s.trail_id = ${params.trailId}
      `);
    };
  }

  /** Removes a stop and closes the gap it leaves (§30). */
  static removeStop(params: {
    trailId: string;
    stopId: string;
  }): (tx: TransactionLike) => Promise<void> {
    return async (tx) => {
      const deleted = await tx.execute<{ position: number }>(sql`
        DELETE FROM trail_stops
         WHERE trail_id = ${params.trailId} AND id = ${params.stopId}
        RETURNING position
      `);

      const position = deleted.rows[0]?.position;
      if (position === undefined) return;

      /* Positions stay contiguous from 1, which the deferred trigger enforces at
         COMMIT. Leaving a hole would make "the third stop" ambiguous. */
      await tx.execute(sql`
        UPDATE trail_stops
           SET position = position - 1
         WHERE trail_id = ${params.trailId} AND position > ${position}
      `);
    };
  }

  /**
   * Rewrites every position to match the given order (§31, §32).
   *
   * Two passes through a high offset rather than one direct assignment. A single pass
   * would move a stop onto a position another still holds, which a future
   * `UNIQUE (trail_id, position)` would reject; parking every row above the occupied
   * range first makes the rewrite order-independent.
   *
   * The offset is positive because `trail_stops_position_positive_check` is a
   * row-level constraint and fires immediately — negative intermediates were the
   * obvious choice and are the one thing the schema forbids. Contiguity is checked at
   * COMMIT by a deferred trigger, so the intermediate state is fine.
   */
  static reorderStops(params: {
    trailId: string;
    orderedStopIds: readonly string[];
  }): (tx: TransactionLike) => Promise<void> {
    return async (tx) => {
      for (const [index, stopId] of params.orderedStopIds.entries()) {
        await tx.execute(sql`
          UPDATE trail_stops SET position = ${REORDER_OFFSET + index + 1}
           WHERE trail_id = ${params.trailId} AND id = ${stopId}
        `);
      }

      await tx.execute(sql`
        UPDATE trail_stops SET position = position - ${REORDER_OFFSET}
         WHERE trail_id = ${params.trailId} AND position > ${REORDER_OFFSET}
      `);
    };
  }

  /** A mutation body that changes nothing but the route — used by recalculate. */
  static noComposedChange(): (tx: TransactionLike) => Promise<void> {
    return () => Promise.resolve();
  }

  /* ---- Non-mutating lifecycle writes --------------------------------------- */

  /**
   * Marks a Trail finished, if it is still at the revision the client saw (§45).
   *
   * Does not bump `revision`: finalizing changes no part of the composition, so the
   * route snapshot still describes it. Bumping would make a freshly finalized Trail
   * report a stale route.
   */
  async finalize(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
  }): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE trails
         SET status = 'FINALIZED', finalized_at = now(), updated_at = now()
       WHERE id = ${params.trailId}
         AND owner_user_id = ${params.ownerUserId}
         AND revision = ${params.expectedRevision}
         AND route_revision = revision
    `);

    return (result.rowCount ?? 0) > 0;
  }

  /** Archives a finalized Trail rather than destroying it (§44). */
  async archive(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
  }): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE trails
         SET status = 'ARCHIVED', finalized_at = NULL, updated_at = now()
       WHERE id = ${params.trailId}
         AND owner_user_id = ${params.ownerUserId}
         AND revision = ${params.expectedRevision}
    `);

    return (result.rowCount ?? 0) > 0;
  }

  /** Hard-deletes a trail and, by cascade, its stops (§44, §50). */
  async delete(params: { trailId: string; ownerUserId: string }): Promise<boolean> {
    const result = await this.db.execute(sql`
      DELETE FROM trails WHERE id = ${params.trailId} AND owner_user_id = ${params.ownerUserId}
    `);

    return (result.rowCount ?? 0) > 0;
  }

  /** Stores the first route for a Trail created while the provider was unreachable. */
  async attachInitialRoute(params: {
    trailId: string;
    route: RouteSnapshotRecord;
    baseRoute: BaseRouteRecord;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE trails
         SET route_geometry = ST_SetSRID(
               ST_GeomFromGeoJSON(${JSON.stringify(params.route.geometry)}), 4326),
             route_distance_meters = ${Math.round(params.route.distanceMeters)},
             route_duration_seconds = ${Math.round(params.route.durationSeconds)},
             route_provider = ${params.route.provider},
             route_calculated_at = now(),
             route_revision = revision,
             base_distance_meters = ${Math.round(params.baseRoute.distanceMeters)},
             base_duration_seconds = ${Math.round(params.baseRoute.durationSeconds)},
             base_calculated_at = now(),
             updated_at = now()
       WHERE id = ${params.trailId}
    `);
  }
}

function toStop(row: TrailStopRow): TrailStop {
  return {
    id: row.id,
    placeId: row.place_id,
    position: row.position,
    source: row.source,
    placeName: row.place_name,
    placeCategoryId: row.place_category_id,
    placeLatitude: row.place_latitude,
    placeLongitude: row.place_longitude,
  };
}

function toTrail(row: TrailRow, stops: TrailStop[]): Trail {
  const origin: TrailEndpoint = {
    latitude: row.origin_latitude,
    longitude: row.origin_longitude,
    placeId: row.origin_place_id,
    label: row.origin_label,
  };
  const destination: TrailEndpoint = {
    latitude: row.destination_latitude,
    longitude: row.destination_longitude,
    placeId: row.destination_place_id,
    label: row.destination_label,
  };

  /* Built from narrowed locals rather than casts: the row's snapshot columns are
     null together or set together (a CHECK constraint enforces it), and reading them
     through explicit locals is what lets the compiler see that. */
  const geometryJson = row.route_geometry;
  const distanceMeters = row.route_distance_meters;
  const durationSeconds = row.route_duration_seconds;
  const routeRevision = row.route_revision;
  const calculatedAt = row.route_calculated_at;
  const north = row.route_north;
  const south = row.route_south;
  const east = row.route_east;
  const west = row.route_west;

  const route: TrailRouteSnapshot | null =
    geometryJson !== null &&
    distanceMeters !== null &&
    durationSeconds !== null &&
    routeRevision !== null &&
    calculatedAt !== null &&
    north !== null &&
    south !== null &&
    east !== null &&
    west !== null
      ? {
          geometry: JSON.parse(geometryJson) as RouteGeometry,
          bounds: { north, south, east, west },
          distanceMeters,
          durationSeconds,
          provider: row.route_provider ?? 'unknown',
          calculatedAt: toDate(calculatedAt),
          revision: routeRevision,
        }
      : null;

  const baseDistance = row.base_distance_meters;
  const baseDuration = row.base_duration_seconds;
  const baseCalculatedAt = row.base_calculated_at;

  const baseRoute: TrailBaseRoute | null =
    baseDistance !== null && baseDuration !== null && baseCalculatedAt !== null
      ? {
          distanceMeters: baseDistance,
          durationSeconds: baseDuration,
          calculatedAt: toDate(baseCalculatedAt),
        }
      : null;

  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    origin,
    destination,
    stops,
    revision: row.revision,
    route,
    baseRoute,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    finalizedAt: row.finalized_at === null ? null : toDate(row.finalized_at),
  };
}

/** Timestamps arrive as strings on the `db.execute` path. */
function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}
