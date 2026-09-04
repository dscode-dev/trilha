import { z } from 'zod';

/**
 * Coordinate validation (§8).
 *
 * **This is the enforcement point, not a convenience.** PostGIS `geography` does not
 * reject an out-of-range coordinate — it *coerces* it. Inserting latitude 91 stores
 * 89, silently, with only a NOTICE. Measured against PostGIS 3.6:
 *
 *   INSERT … ST_MakePoint(0, 91)::geography  →  NOTICE: coerced into range  →  lat 89
 *
 * A place would land 200 km from where the user put it and nothing would say so. The
 * database CHECK constraint cannot help, because by the time it runs the value has
 * already been folded into range. So the guard has to be here, before the value ever
 * reaches SQL.
 */

export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;

/**
 * Builds a bounded numeric schema for a coordinate arriving from JSON or a query
 * string, with the coercion traps closed.
 *
 * `z.coerce.number()` already rejects NaN and ±Infinity in Zod 4 — verified, not
 * assumed. What it does *not* reject is an empty string or null: both pass through
 * `Number()` and become **0**. For a coordinate that is a silent, plausible-looking
 * disaster — `?lat=&lng=` would place a point at 0°, 0° in the Gulf of Guinea with no
 * error anywhere. Missing input has to fail, so it is rejected before coercion.
 */
function boundedCoordinate(min: number, max: number, label: string) {
  return z.union([z.number(), z.string().trim().min(1).transform(Number)]).pipe(
    z
      .number()
      .min(min, { message: `${label} must be at least ${String(min)}` })
      .max(max, { message: `${label} must be at most ${String(max)}` }),
  );
}

export const latitudeSchema = boundedCoordinate(LATITUDE_MIN, LATITUDE_MAX, 'Latitude');
export const longitudeSchema = boundedCoordinate(LONGITUDE_MIN, LONGITUDE_MAX, 'Longitude');

export const coordinatesSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});

export type Coordinates = z.infer<typeof coordinatesSchema>;

/* ---- Radius search bounds (§17) ------------------------------------------ */

export const RADIUS_MIN_METRES = 10;
/** 50 km. Beyond this a radius search stops being "nearby" and starts being a scan. */
export const RADIUS_MAX_METRES = 50_000;
export const RADIUS_DEFAULT_METRES = 2_000;

export const radiusMetresSchema = z
  .union([z.number(), z.string().trim().min(1).transform(Number)])
  .pipe(
    z
      .number()
      .int({ message: 'radiusMeters must be a whole number of metres' })
      .min(RADIUS_MIN_METRES, {
        message: `radiusMeters must be at least ${String(RADIUS_MIN_METRES)}`,
      })
      .max(RADIUS_MAX_METRES, {
        message: `radiusMeters must be at most ${String(RADIUS_MAX_METRES)}`,
      }),
  )
  .default(RADIUS_DEFAULT_METRES);

/* ---- Bounding box (§18, §19) --------------------------------------------- */

/**
 * Largest viewport accepted, in degrees of latitude.
 *
 * A world-spanning box would return everything, which is a table scan wearing a
 * viewport costume. The client zooms out past this and gets a clear error instead of
 * a slow success.
 */
export const BBOX_MAX_SPAN_DEGREES = 5;

export const boundingBoxSchema = z
  .object({
    north: latitudeSchema,
    south: latitudeSchema,
    east: longitudeSchema,
    west: longitudeSchema,
  })
  .refine((box) => box.north > box.south, {
    message: 'north must be greater than south',
    path: ['north'],
  })
  .refine((box) => box.east > box.west, {
    /**
     * Antimeridian (§19).
     *
     * A viewport straddling ±180° arrives with `west > east`, and handling it means
     * splitting the query into two boxes. V1 rejects it explicitly rather than
     * treating it as a silently empty result — Trilha's users are in Brazil, so this
     * is an edge case worth naming, not worth building for yet.
     */
    message:
      'east must be greater than west. Viewports crossing the antimeridian are not supported.',
    path: ['east'],
  })
  .refine((box) => box.north - box.south <= BBOX_MAX_SPAN_DEGREES, {
    message: `The viewport is too large. Zoom in to at most ${String(BBOX_MAX_SPAN_DEGREES)}° of latitude.`,
    path: ['north'],
  })
  .refine((box) => box.east - box.west <= BBOX_MAX_SPAN_DEGREES, {
    message: `The viewport is too large. Zoom in to at most ${String(BBOX_MAX_SPAN_DEGREES)}° of longitude.`,
    path: ['east'],
  });

export type BoundingBox = z.infer<typeof boundingBoxSchema>;
