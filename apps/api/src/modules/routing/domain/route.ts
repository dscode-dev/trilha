import { InvalidRouteGeometryError } from './routing-errors.js';

/**
 * Routing domain types.
 *
 * Plain data — no Nest, no HTTP, no provider vocabulary. A `Route` is a computed path
 * between two points and nothing more: it carries no name, no author, no stops and no
 * social meaning. Those belong to `Trail`, which is a different concept entirely
 * (constitution §Routing) and arrives in its own PR.
 */

/** A point in WGS84 degrees. */
export interface RoutePoint {
  readonly latitude: number;
  readonly longitude: number;
  /** Set when the endpoint came from an existing Place. Routing never requires one. */
  readonly placeId?: string | undefined;
}

/**
 * Route geometry as GeoJSON.
 *
 * GeoJSON rather than an encoded polyline: PostGIS reads it directly with
 * `ST_GeomFromGeoJSON`, so the corridor can be derived without a decode step, and it
 * stays readable in a payload someone is debugging. An encoded polyline is a
 * transport optimisation, not a representation of truth (ADR-0013).
 */
export interface RouteGeometry {
  readonly type: 'LineString';
  /** `[longitude, latitude]` pairs — GeoJSON axis order, not lat/lng. */
  readonly coordinates: readonly (readonly [number, number])[];
}

/**
 * Canonical units: metres and seconds (constitution §Routing).
 *
 * Kilometres and minutes are presentation choices and are made in the client.
 */
export interface RouteMetrics {
  readonly distanceMeters: number;
  readonly durationSeconds: number;
}

/** Geographic extent of the geometry, for fitting a camera. */
export interface RouteBounds {
  readonly north: number;
  readonly south: number;
  readonly east: number;
  readonly west: number;
}

/**
 * One segment of a route.
 *
 * PR-03 always produces exactly one leg, because the API accepts only origin and
 * destination. The array exists so that adding waypoints later is a change to the
 * request, not a restructuring of the result (§16).
 */
export interface RouteLeg {
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  /** Human-readable endpoints as the provider named them, when it supplies them. */
  readonly summary: string | null;
}

/**
 * The area within a given distance of the route.
 *
 * Derived from the geometry by PostGIS, never returned by the provider. PR-04 uses it
 * to ask "which Places lie along this route"; PR-03 only has to produce it correctly.
 */
export interface RouteCorridor {
  readonly widthMeters: number;
  /** GeoJSON Polygon or MultiPolygon, as produced by the buffer. */
  readonly geometry: unknown;
}

/** The normalised result of a route calculation. */
export interface Route {
  readonly origin: RoutePoint;
  readonly destination: RoutePoint;
  readonly geometry: RouteGeometry;
  readonly metrics: RouteMetrics;
  readonly bounds: RouteBounds;
  readonly legs: readonly RouteLeg[];
  readonly corridor: RouteCorridor | null;
  /**
   * Which provider computed this, by name (PR-05, §18).
   *
   * Non-sensitive attribution — never a URL and never a credential. A Trail persists
   * it so that a snapshot saved today is attributable after a change of supplier.
   */
  readonly provider: string;
}

/**
 * Computes bounds from the geometry rather than trusting the provider (§17).
 *
 * Deterministic and cheap, and it cannot disagree with the line that will actually be
 * drawn — which a provider-supplied bounding box can, if it describes an alternative
 * or a simplified overview.
 */
export function boundsOf(geometry: RouteGeometry): RouteBounds {
  const [first] = geometry.coordinates;
  if (first === undefined) {
    throw new Error('Cannot compute bounds of an empty geometry');
  }

  let north = first[1];
  let south = first[1];
  let east = first[0];
  let west = first[0];

  for (const [longitude, latitude] of geometry.coordinates) {
    if (latitude > north) north = latitude;
    if (latitude < south) south = latitude;
    if (longitude > east) east = longitude;
    if (longitude < west) west = longitude;
  }

  return { north, south, east, west };
}

/**
 * Great-circle distance in metres.
 *
 * Used only to reject a request *before* it reaches a metered provider — a degenerate
 * pair, or endpoints so far apart that the input is almost certainly wrong. It is not
 * a routing distance and never appears in a result: the road distance comes from the
 * provider, and PostGIS owns every spatial measurement that matters
 * (constitution §Geography).
 */
export function greatCircleMeters(a: RoutePoint, b: RoutePoint): number {
  const earthRadiusMeters = 6_371_008.8;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLng = toRadians(b.longitude - a.longitude);
  const latA = toRadians(a.latitude);
  const latB = toRadians(b.latitude);

  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A LineString needs at least two positions to describe a line. */
export const MINIMUM_LINE_POSITIONS = 2;

/**
 * Validates a GeoJSON LineString position by position.
 *
 * Lives in the domain because "what counts as a usable route geometry" is a Trilha
 * invariant, not a property of whichever provider produced it — and because more than
 * one entry point needs it. PostGIS is emphatically *not* a backstop here: it accepts
 * a single-position LineString and buffers it into a circle, so a degenerate geometry
 * that slipped through would produce a corridor around a point and no error anywhere.
 */
export function parseLineString(value: unknown): RouteGeometry {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidRouteGeometryError('Geometry is missing');
  }

  const candidate = value as { type?: unknown; coordinates?: unknown };
  if (candidate.type !== 'LineString') {
    throw new InvalidRouteGeometryError('Geometry is not a LineString');
  }
  if (!Array.isArray(candidate.coordinates)) {
    throw new InvalidRouteGeometryError('Geometry coordinates are not an array');
  }
  if (candidate.coordinates.length < MINIMUM_LINE_POSITIONS) {
    throw new InvalidRouteGeometryError('A LineString needs at least two positions');
  }

  const coordinates: [number, number][] = candidate.coordinates.map((position: unknown) => {
    if (!Array.isArray(position) || position.length < 2) {
      throw new InvalidRouteGeometryError('A position must be a [longitude, latitude] pair');
    }

    const [longitude, latitude] = position as unknown[];
    if (
      typeof longitude !== 'number' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw new InvalidRouteGeometryError('A position is outside valid coordinate bounds');
    }

    return [longitude, latitude];
  });

  return { type: 'LineString', coordinates };
}
