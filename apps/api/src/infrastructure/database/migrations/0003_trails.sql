CREATE TYPE "public"."trail_status" AS ENUM('DRAFT', 'FINALIZED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."trail_stop_source" AS ENUM('DISCOVERY', 'SEARCH', 'MANUAL');--> statement-breakpoint
CREATE TABLE "trail_stops" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"trail_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"source" "trail_stop_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trail_stops_position_positive_check" CHECK ("trail_stops"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "trails" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status" "trail_status" DEFAULT 'DRAFT' NOT NULL,
	"origin_location" geography(Point, 4326) NOT NULL,
	"origin_place_id" uuid,
	"origin_label" text,
	"destination_location" geography(Point, 4326) NOT NULL,
	"destination_place_id" uuid,
	"destination_label" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"route_geometry" geometry(LineString, 4326),
	"route_distance_meters" integer,
	"route_duration_seconds" integer,
	"route_provider" text,
	"route_calculated_at" timestamp with time zone,
	"route_revision" integer,
	"base_distance_meters" integer,
	"base_duration_seconds" integer,
	"base_calculated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "trails_revision_positive_check" CHECK ("trails"."revision" >= 1),
	CONSTRAINT "trails_route_revision_range_check" CHECK ("trails"."route_revision" IS NULL OR ("trails"."route_revision" >= 1 AND "trails"."route_revision" <= "trails"."revision")),
	CONSTRAINT "trails_route_snapshot_complete_check" CHECK (("trails"."route_geometry" IS NULL AND "trails"."route_distance_meters" IS NULL
            AND "trails"."route_duration_seconds" IS NULL AND "trails"."route_revision" IS NULL
            AND "trails"."route_calculated_at" IS NULL)
          OR ("trails"."route_geometry" IS NOT NULL AND "trails"."route_distance_meters" IS NOT NULL
            AND "trails"."route_duration_seconds" IS NOT NULL AND "trails"."route_revision" IS NOT NULL
            AND "trails"."route_calculated_at" IS NOT NULL)),
	CONSTRAINT "trails_route_metrics_non_negative_check" CHECK (("trails"."route_distance_meters" IS NULL OR "trails"."route_distance_meters" >= 0)
          AND ("trails"."route_duration_seconds" IS NULL OR "trails"."route_duration_seconds" >= 0)
          AND ("trails"."base_distance_meters" IS NULL OR "trails"."base_distance_meters" >= 0)
          AND ("trails"."base_duration_seconds" IS NULL OR "trails"."base_duration_seconds" >= 0)),
	CONSTRAINT "trails_finalized_at_matches_status_check" CHECK (("trails"."status" = 'FINALIZED') = ("trails"."finalized_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "trail_stops" ADD CONSTRAINT "trail_stops_trail_id_trails_id_fk" FOREIGN KEY ("trail_id") REFERENCES "public"."trails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trail_stops" ADD CONSTRAINT "trail_stops_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trails" ADD CONSTRAINT "trails_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trails" ADD CONSTRAINT "trails_origin_place_id_places_id_fk" FOREIGN KEY ("origin_place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trails" ADD CONSTRAINT "trails_destination_place_id_places_id_fk" FOREIGN KEY ("destination_place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trail_stops_trail_position_idx" ON "trail_stops" USING btree ("trail_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "trail_stops_trail_place_unique" ON "trail_stops" USING btree ("trail_id","place_id");--> statement-breakpoint
CREATE INDEX "trails_owner_updated_idx" ON "trails" USING btree ("owner_user_id","updated_at" DESC NULLS LAST);
--> statement-breakpoint

-- Endpoint coordinate bounds.
--
-- The same reasoning as `places_location_bounds_check`: PostGIS `geography` coerces
-- an out-of-range coordinate rather than rejecting it, so this is not the real guard
-- — application validation is. It states the invariant where a reader of the schema
-- will find it, and catches a value arriving from some future code path (§48).
ALTER TABLE "trails" ADD CONSTRAINT "trails_endpoint_bounds_check" CHECK (
  ST_X("origin_location"::geometry) BETWEEN -180 AND 180
  AND ST_Y("origin_location"::geometry) BETWEEN -90 AND 90
  AND ST_X("destination_location"::geometry) BETWEEN -180 AND 180
  AND ST_Y("destination_location"::geometry) BETWEEN -90 AND 90
);--> statement-breakpoint

-- Label bounds, so an oversized payload cannot reach storage even if an
-- application-layer check is ever bypassed.
ALTER TABLE "trails" ADD CONSTRAINT "trails_origin_label_length_check"
  CHECK ("origin_label" IS NULL OR char_length("origin_label") <= 120);--> statement-breakpoint
ALTER TABLE "trails" ADD CONSTRAINT "trails_destination_label_length_check"
  CHECK ("destination_label" IS NULL OR char_length("destination_label") <= 120);--> statement-breakpoint

-- A stored route must be a line, not a point buffered into one. PostGIS accepts a
-- single-position LineString and would happily store a degenerate route (ADR-0013).
ALTER TABLE "trails" ADD CONSTRAINT "trails_route_geometry_is_a_line_check" CHECK (
  "route_geometry" IS NULL OR ST_NPoints("route_geometry") >= 2
);--> statement-breakpoint

-- Stop positions must be contiguous from 1 within a Trail.
--
-- Not expressible as a row-level CHECK, so it is a deferred trigger: a reorder
-- necessarily passes through intermediate states where two rows briefly share a
-- position, and an immediate constraint would reject the legitimate write. Deferring
-- to COMMIT asserts the invariant on the state that actually gets persisted (§48).
CREATE OR REPLACE FUNCTION trilha_assert_trail_stop_positions() RETURNS trigger AS $$
DECLARE
  offending uuid;
BEGIN
  SELECT s.trail_id INTO offending
    FROM "trail_stops" s
   WHERE s.trail_id = COALESCE(NEW.trail_id, OLD.trail_id)
   GROUP BY s.trail_id
  HAVING COUNT(*) <> MAX(s.position)
      OR COUNT(DISTINCT s.position) <> COUNT(*)
      OR MIN(s.position) <> 1;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'trail % has non-contiguous stop positions', offending
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER trail_stops_positions_contiguous
  AFTER INSERT OR UPDATE OR DELETE ON "trail_stops"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trilha_assert_trail_stop_positions();
