-- Trilha — 0002_places
--
-- The first geographic domain: Places, their categories, the text-search machinery
-- the name lookup needs, and an audit log owned by this module.

-- Trigram index support for the name search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- Accent folding: Portuguese place names are full of diacritics, and a search for
-- "sao paulo" must find "São Paulo".
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint

-- `unaccent()` is declared STABLE, because it resolves a dictionary by name at call
-- time and a dictionary can be redefined. Generated columns and expression indexes
-- both require IMMUTABLE. Pinning the dictionary removes the variability, which makes
-- this wrapper genuinely immutable rather than merely labelled so.
CREATE OR REPLACE FUNCTION trilha_immutable_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  STRICT
  PARALLEL SAFE
AS $$ SELECT public.unaccent('public.unaccent', $1) $$;--> statement-breakpoint

CREATE TYPE "public"."place_audit_event_type" AS ENUM('PLACE_CREATED');--> statement-breakpoint
CREATE TYPE "public"."place_provenance" AS ENUM('COMMUNITY', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."place_status" AS ENUM('ACTIVE', 'PENDING_REVIEW', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "place_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_type" "place_audit_event_type" NOT NULL,
	"place_id" uuid,
	"actor_user_id" uuid,
	"request_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "place_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"search_text" text GENERATED ALWAYS AS (trilha_immutable_unaccent(lower(name))) STORED NOT NULL,
	"category_id" text NOT NULL,
	"location" geography(Point, 4326) NOT NULL,
	"description" text,
	"provenance" "place_provenance" NOT NULL,
	"status" "place_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "place_audit_events" ADD CONSTRAINT "place_audit_events_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_audit_events" ADD CONSTRAINT "place_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_category_id_place_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."place_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_audit_events_place_id_idx" ON "place_audit_events" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "places_location_gist_idx" ON "places" USING gist ("location");--> statement-breakpoint
CREATE INDEX "places_search_text_trgm_idx" ON "places" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "places_status_idx" ON "places" USING btree ("status");--> statement-breakpoint
CREATE INDEX "places_created_by_idx" ON "places" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "places_search_text_category_idx" ON "places" USING btree ("search_text","category_id");
--> statement-breakpoint
-- Coordinate bounds.
--
-- Note what this does *not* do: PostGIS `geography` silently coerces an out-of-range
-- coordinate rather than rejecting it — inserting latitude 91 stores 89, with only a
-- NOTICE — so by the time this constraint runs the value is already in range. The
-- real guard is application-side validation (see domain/coordinates.ts). This states
-- the invariant where a reader of the schema will find it, and catches a value that
-- arrives already as a valid geometry from some future code path (§8).
ALTER TABLE "places" ADD CONSTRAINT "places_location_bounds_check" CHECK (
  ST_X("location"::geometry) BETWEEN -180 AND 180
  AND ST_Y("location"::geometry) BETWEEN -90 AND 90
);--> statement-breakpoint

-- Text bounds, so an oversized payload cannot reach storage even if an
-- application-layer check is ever bypassed (§14).
ALTER TABLE "places" ADD CONSTRAINT "places_name_length_check"
  CHECK (char_length("name") BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_description_length_check"
  CHECK ("description" IS NULL OR char_length("description") <= 1000);--> statement-breakpoint

-- A community submission must record who made it; a SYSTEM row must not pretend to.
ALTER TABLE "places" ADD CONSTRAINT "places_community_has_author_check" CHECK (
  ("provenance" <> 'COMMUNITY') OR ("created_by_user_id" IS NOT NULL)
);--> statement-breakpoint

-- Category reference data. Not product content: the FK on places.category_id cannot
-- be satisfied without it, so it belongs to the schema rather than to a seed script
-- (§66).
INSERT INTO "place_categories" ("id", "label", "sort_order") VALUES
  ('FOOD',            'Food & drink',      10),
  ('NATURE',          'Nature',            20),
  ('HISTORY_CULTURE', 'History & culture', 30),
  ('LEISURE',         'Leisure',           40),
  ('SHOPPING',        'Shopping',          50),
  ('LANDMARK',        'Landmark',          60),
  ('ACCOMMODATION',   'Accommodation',     70),
  ('SERVICE',         'Services',          80),
  ('OTHER',           'Other',             90)
ON CONFLICT ("id") DO NOTHING;
