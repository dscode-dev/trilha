import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '../../places/domain/coordinates.js';
import { DegenerateRouteError, RouteTooLongError } from './routing-errors.js';
import { greatCircleMeters, type RoutePoint } from './route.js';

/**
 * Request validation for routing (§8, §55, §56).
 *
 * Coordinate rules are imported from the Places domain rather than restated. They are
 * the same rules — including the trap where an empty string coerces to 0 and would
 * silently route from the Gulf of Guinea — and a second copy would eventually
 * disagree with the first.
 */

const endpointSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  /** Present when the endpoint came from a Place. Routing never requires one (§7). */
  placeId: z.uuid().optional(),
});

export const calculateRouteSchema = z.object({
  origin: endpointSchema,
  destination: endpointSchema,
});

export type CalculateRouteBody = z.infer<typeof calculateRouteSchema>;

/**
 * Below this the two points are the same place.
 *
 * Consumer GPS is accurate to roughly ±5–10 m, so anything inside 25 m is as likely
 * to be measurement noise as a real journey. Rejecting here also keeps a meaningless
 * request from reaching a metered provider (§55).
 */
export const MINIMUM_SEPARATION_METERS = 25;

/**
 * Above this the input is almost certainly wrong rather than ambitious.
 *
 * 5,000 km comfortably exceeds any drive within Brazil — the longest, Oiapoque to
 * Chuí, is about 5,000 km of road but well under that in a straight line. What it
 * does catch is swapped latitude and longitude, or a sign error, both of which
 * otherwise become a very large bill for a route nobody wanted. It is a sanity bound,
 * not a product limit (§56).
 */
export const MAXIMUM_SEPARATION_METERS = 5_000_000;

/**
 * Rejects requests that must not reach the provider.
 *
 * Runs before any upstream call, so a bad pair costs nothing.
 */
export function assertRoutableEndpoints(origin: RoutePoint, destination: RoutePoint): void {
  const separation = greatCircleMeters(origin, destination);

  if (separation < MINIMUM_SEPARATION_METERS) {
    throw new DegenerateRouteError(MINIMUM_SEPARATION_METERS);
  }
  if (separation > MAXIMUM_SEPARATION_METERS) {
    throw new RouteTooLongError(MAXIMUM_SEPARATION_METERS);
  }
}
