import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { geographyPoint, places } from './places.js';

/**
 * Trails — the first thing a user *composes* (PR-05).
 *
 * A Trail is not a Route. A Route is what the road network says about getting from A
 * to B; a Trail is a person's intent — which places, in which order, deliberately
 * saved (constitution §Trail). Routing owns geometry, distance and duration; a Trail
 * owns the composition and keeps a snapshot of what routing last said about it.
 *
 * Nothing here is social. There is no `is_public`, no slug, no comment count and no
 * rating: publication belongs to a later PR, and a column reserved for it now is an
 * invitation to fill it with something that has no rules yet (§72).
 */

/**
 * Route geometry as `geometry(LineString, 4326)`.
 *
 * `geometry`, not `geography`, and deliberately so — the opposite of ADR-0010's
 * choice for Places. A Place's column exists to answer *distance* questions, where
 * degrees are meaningless. This column exists to *store a line* that was already
 * measured upstream: every metric on a Trail comes from the routing provider, and the
 * only spatial operations run against this are casts to `geography` at read time
 * (length, bounds). `geography` would also refuse the antimeridian-spanning lines a
 * global product will eventually produce.
 */
export const geometryLineString = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(LineString, 4326)';
  },
});

/**
 * Lifecycle (§7).
 *
 * `DRAFT` while it is being built, `FINALIZED` once the user says they are done, and
 * `ARCHIVED` for a finished Trail they no longer want listed. Deliberately three
 * states and no more: `PUBLISHED`, `PENDING_REVIEW` and `SHARED` describe a social
 * lifecycle that does not exist yet.
 *
 * A `FINALIZED` Trail is still editable by its owner; the first change returns it to
 * `DRAFT` (§46). That keeps "finished" an honest description of the current state
 * rather than a one-way door, and avoids immutable versioning that nothing needs yet.
 */
export const trailStatus = pgEnum('trail_status', ['DRAFT', 'FINALIZED', 'ARCHIVED']);

/**
 * Where a stop came from (§11).
 *
 * Provenance of the *composition*, not a quality signal and never an input to any
 * ranking. `AI` is absent because nothing can produce it yet.
 */
export const trailStopSource = pgEnum('trail_stop_source', ['DISCOVERY', 'SEARCH', 'MANUAL']);

export const trails = pgTable(
  'trails',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    /**
     * The single owner. Invariant for the life of the Trail (§8).
     *
     * `cascade` on delete, unlike `places.created_by_user_id`: a Place belongs to the
     * platform and outlives its contributor, but a Trail is that person's private
     * composition and has no meaning without them.
     */
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    status: trailStatus('status').notNull().default('DRAFT'),

    /* ---- Endpoints, snapshotted onto the Trail (§9) -------------------------
       A Trail's endpoints need not be Places: "from where I am now" is a perfectly
       good origin. `place_id` is recorded when one was chosen, so a later PR can
       show the Place, and `label` preserves what the user saw at the time. */
    originLocation: geographyPoint('origin_location').notNull(),
    originPlaceId: uuid('origin_place_id').references(() => places.id, {
      onDelete: 'set null',
    }),
    originLabel: text('origin_label'),

    destinationLocation: geographyPoint('destination_location').notNull(),
    destinationPlaceId: uuid('destination_place_id').references(() => places.id, {
      onDelete: 'set null',
    }),
    destinationLabel: text('destination_label'),

    /**
     * Monotonic composition counter — the basis of every safe write (§24, §25).
     *
     * Incremented by exactly one on each accepted mutation. Clients send the revision
     * they believe they are editing, and a compare-and-set on this column is what
     * turns two concurrent edits into one success and one 409 rather than a lost
     * update.
     */
    revision: integer('revision').notNull().default(1),

    /* ---- Composed route snapshot (§18, §20) ---------------------------------
       What routing last said about *this* composition, in Trilha's own vocabulary.
       Never the provider's raw payload: a Trail saved today must still be readable
       after a change of supplier.

       Nullable as a set: a Trail may exist before its first successful calculation,
       because a draft is worth more to a user than an error is (§26). */
    routeGeometry: geometryLineString('route_geometry'),
    routeDistanceMeters: integer('route_distance_meters'),
    routeDurationSeconds: integer('route_duration_seconds'),
    /** Non-sensitive attribution, for support. Never a URL and never a credential. */
    routeProvider: text('route_provider'),
    routeCalculatedAt: timestamp('route_calculated_at', { withTimezone: true }),

    /**
     * The trail revision this snapshot describes (§24).
     *
     * Equal to `revision` means the drawn route matches the current composition. Less
     * than it means the snapshot is stale. A boolean `routing_dirty` would carry the
     * same bit and none of the evidence — this says *which* composition was measured.
     */
    routeRevision: integer('route_revision'),

    /* ---- Base route snapshot (§39) ------------------------------------------
       A → B with no stops, so the app can say what the detour costs *in total*.
       Depends only on the endpoints, so it survives stop edits and is recomputed
       whenever the endpoints change (ADR-0016). */
    baseDistanceMeters: integer('base_distance_meters'),
    baseDurationSeconds: integer('base_duration_seconds'),
    baseCalculatedAt: timestamp('base_calculated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the user says they are done; cleared if they edit again (§46). */
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (table) => [
    /* The one listing query: my trails, most recently touched first (§42, §49). */
    index('trails_owner_updated_idx').on(table.ownerUserId, table.updatedAt.desc()),

    check('trails_revision_positive_check', sql`${table.revision} >= 1`),
    /* A snapshot can be absent, but it cannot claim to describe a composition that
       has not happened yet. */
    check(
      'trails_route_revision_range_check',
      sql`${table.routeRevision} IS NULL OR (${table.routeRevision} >= 1 AND ${table.routeRevision} <= ${table.revision})`,
    ),
    /* Metrics and geometry arrive together or not at all: half a snapshot would let a
       screen render a distance with no line, or a line with no distance. */
    check(
      'trails_route_snapshot_complete_check',
      sql`(${table.routeGeometry} IS NULL AND ${table.routeDistanceMeters} IS NULL
            AND ${table.routeDurationSeconds} IS NULL AND ${table.routeRevision} IS NULL
            AND ${table.routeCalculatedAt} IS NULL)
          OR (${table.routeGeometry} IS NOT NULL AND ${table.routeDistanceMeters} IS NOT NULL
            AND ${table.routeDurationSeconds} IS NOT NULL AND ${table.routeRevision} IS NOT NULL
            AND ${table.routeCalculatedAt} IS NOT NULL)`,
    ),
    check(
      'trails_route_metrics_non_negative_check',
      sql`(${table.routeDistanceMeters} IS NULL OR ${table.routeDistanceMeters} >= 0)
          AND (${table.routeDurationSeconds} IS NULL OR ${table.routeDurationSeconds} >= 0)
          AND (${table.baseDistanceMeters} IS NULL OR ${table.baseDistanceMeters} >= 0)
          AND (${table.baseDurationSeconds} IS NULL OR ${table.baseDurationSeconds} >= 0)`,
    ),
    /* A finalized Trail is one the user called finished; the timestamp records when
       and must not disagree with the status. */
    check(
      'trails_finalized_at_matches_status_check',
      sql`(${table.status} = 'FINALIZED') = (${table.finalizedAt} IS NOT NULL)`,
    ),
  ],
);

export const trailStops = pgTable(
  'trail_stops',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    trailId: uuid('trail_id')
      .notNull()
      .references(() => trails.id, { onDelete: 'cascade' }),

    /**
     * A stop is always a resolved Place (constitution §Domain, §10).
     *
     * `restrict` on delete rather than `cascade` or `set null`: a Trail records where
     * someone decided to go, and silently removing a stop because the Place row went
     * away would rewrite their composition without asking. Places are archived rather
     * than deleted, so this constraint should never fire — and if it ever does, the
     * right outcome is a refused delete, not a mutilated Trail (§50, §51).
     */
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'restrict' }),

    /**
     * Explicit order, 1-based and contiguous (§12, §13).
     *
     * Never derived from `created_at`: a reorder changes the order without creating
     * anything, so insertion time stops describing the sequence the moment the user
     * drags a row. Plain integers rather than fractional indexing — a Trail holds at
     * most fifteen stops, and rewriting fifteen integers is cheaper than the
     * machinery that avoids it.
     */
    position: integer('position').notNull(),

    /** Where the addition came from. Provenance, not quality (§11). */
    source: trailStopSource('source').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* The one read: a trail's stops in order (§49). */
    index('trail_stops_trail_position_idx').on(table.trailId, table.position),

    /* One visit per Place per Trail in V1 (§33). Visiting the same place twice is a
       real journey, but it needs an order model that says which visit is which, and
       nothing in V1 needs it. */
    uniqueIndex('trail_stops_trail_place_unique').on(table.trailId, table.placeId),

    check('trail_stops_position_positive_check', sql`${table.position} >= 1`),
  ],
);
