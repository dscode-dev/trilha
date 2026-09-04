import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

/**
 * Places — the first geographic domain (PR-02).
 *
 * A Place is a location Trilha knows about. It is deliberately *not* a stop on a
 * trail, a routing candidate, or an event venue (constitution §Domain): those are
 * separate concepts that reference a Place, and collapsing them would make a Place
 * unreusable across trails.
 */

/**
 * `geography(Point, 4326)`.
 *
 * Drizzle ships a `geometry` column type, but `geometry` is the wrong choice here:
 * `ST_Distance` over `geometry` returns *degrees*, which is meaningless as a
 * distance and wrong by a latitude-dependent factor. `geography` computes on the
 * spheroid and returns metres, so a radius search means what it says at Recife's
 * latitude as much as at the equator (ADR-0010).
 *
 * Values cross the driver as WKT/EWKT text; every read goes through `ST_X`/`ST_Y`
 * or `ST_AsGeoJSON` in an explicit query, so this type exists to make the DDL and
 * the index correct rather than to hide PostGIS behind an abstraction.
 */
export const geographyPoint = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'geography(Point, 4326)';
  },
});

/**
 * How a Place came to be known (§11).
 *
 * Only the values PR-02 can actually produce. `AI_DISCOVERED` and `EXTERNAL` are
 * deliberately absent: marking rows with a provenance no code path can create would
 * be a fiction, and the enum is cheap to extend when those sources exist.
 */
export const placeProvenance = pgEnum('place_provenance', ['COMMUNITY', 'SYSTEM']);

/**
 * Lifecycle (§13).
 *
 * Community submissions land in `ACTIVE`. `PENDING_REVIEW` exists in the type because
 * moderation is a known future need, but nothing sets it yet — routing new Places
 * into a state with no queue to release them would strand every submission until the
 * moderation PR lands.
 */
export const placeStatus = pgEnum('place_status', ['ACTIVE', 'PENDING_REVIEW', 'ARCHIVED']);

/**
 * Category as a lookup table rather than an enum (§10).
 *
 * Categories will be edited, reordered and retired by product decisions; an enum
 * makes each of those a migration with a lock on every dependent table. A table
 * keeps the referential guarantee and makes changes ordinary DML. The id is a stable
 * text key, not a serial, so fixtures and clients can name a category without
 * resolving a number first.
 */
export const placeCategories = pgTable('place_categories', {
  /** Stable machine key, e.g. `FOOD`. Never renamed once published. */
  id: text('id').primaryKey(),

  /** Human label. Localisation belongs to the client, not to this row. */
  label: text('label').notNull(),

  /** Display order in pickers; ties broken by label. */
  sortOrder: integer('sort_order').notNull().default(0),

  /** Retire a category without deleting rows that reference it. */
  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const places = pgTable(
  'places',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    name: text('name').notNull(),

    /**
     * Case- and accent-folded name, computed by the database.
     *
     * Portuguese place names are full of diacritics, and a search for "sao paulo"
     * must find "São Paulo". `unaccent()` is STABLE and so cannot appear in a
     * generated column; `trilha_immutable_unaccent` pins the dictionary, which makes
     * it genuinely immutable. The trigram index below sits on this column.
     */
    searchText: text('search_text')
      .notNull()
      .generatedAlwaysAs(sql`trilha_immutable_unaccent(lower(name))`),

    categoryId: text('category_id')
      .notNull()
      .references(() => placeCategories.id, { onDelete: 'restrict' }),

    /** The spatial source of truth. No lat/lng columns shadow it. */
    location: geographyPoint('location').notNull(),

    description: text('description'),

    provenance: placeProvenance('provenance').notNull(),
    status: placeStatus('status').notNull().default('ACTIVE'),

    /**
     * Who submitted it — attribution, not ownership (§12).
     *
     * `set null` on delete: a Place outlives the account that contributed it, because
     * it belongs to the platform. Nullable for the same reason, and because
     * `SYSTEM` provenance has no submitter.
     */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* Every spatial predicate — radius and viewport alike — depends on this. */
    index('places_location_gist_idx').using('gist', table.location),

    /* Trigram index for the ILIKE/similarity search in §22. */
    index('places_search_text_trgm_idx').using('gin', sql`${table.searchText} gin_trgm_ops`),

    /* Map and list queries filter on status before anything else. */
    index('places_status_idx').on(table.status),

    /* "Places I contributed" — and the audit path for a problematic submitter. */
    index('places_created_by_idx').on(table.createdByUserId),

    /* Supports the near-duplicate probe in §16: same name, same category, nearby. */
    index('places_search_text_category_idx').on(table.searchText, table.categoryId),
  ],
);

/**
 * Audit events for the Places domain (§34).
 *
 * Separate from `auth_audit_events` on purpose. ADR-0001 holds that a module owns its
 * data and other modules reach it through the owning module's surface, not through
 * its tables — so `places` writing into identity's audit log would breach the very
 * boundary the modular monolith depends on. Consolidating both into shared audit
 * infrastructure is worth doing once a third domain needs it; two small tables do not
 * justify it yet.
 */
export const placeAuditEventType = pgEnum('place_audit_event_type', ['PLACE_CREATED']);

export const placeAuditEvents = pgTable(
  'place_audit_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    eventType: placeAuditEventType('event_type').notNull(),

    placeId: uuid('place_id').references(() => places.id, { onDelete: 'set null' }),

    /** Nullable: a SYSTEM-provenance row has no actor. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),

    /** Ties the event back to the HTTP request that caused it. */
    requestId: text('request_id'),

    /**
     * Identifiers and counts only. Never coordinates: an audit row recording where a
     * person was standing is location history by another name (§70).
     */
    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('place_audit_events_place_id_idx').on(table.placeId)],
);

/** Categories seeded by migration. Reference data, not product content (§66). */
export const PLACE_CATEGORY_IDS = [
  'FOOD',
  'NATURE',
  'HISTORY_CULTURE',
  'LEISURE',
  'SHOPPING',
  'LANDMARK',
  'ACCOMMODATION',
  'SERVICE',
  'OTHER',
] as const;

export type PlaceCategoryId = (typeof PLACE_CATEGORY_IDS)[number];
