import { z } from 'zod';
import { calculateRouteSchema } from '../../routing/domain/route-request.js';

/**
 * What a discovery request may ask for (§8, §22, §23).
 *
 * **The route is not an input.** The client sends the same origin and destination it
 * would send to `/routes/calculate`, and the backend computes the route itself with
 * the Routing Core (§9). Accepting a geometry from the client would mean accepting an
 * arbitrary LineString as the basis of a spatial query and a batch of metered provider
 * calls — a caller could post a line tracing the entire coastline and make Trilha pay
 * to evaluate it. There is no version of "validate it carefully" that makes an
 * attacker-supplied search area as safe as one Trilha derived itself, and the extra
 * route calculation costs one call against a ceiling that is already bounded.
 */

/** Category ids are reference data owned by Places; discovery does not restate them (§23). */
const CATEGORY_ID_PATTERN = /^[A-Z][A-Z_]{1,39}$/;

export const MAX_CATEGORY_FILTERS = 12;

export const discoveryQuerySchema = calculateRouteSchema.extend({
  /**
   * Half-width of the search corridor. Clamped server-side to the routing maximum,
   * so a client cannot widen the spatial query into a full-table scan.
   */
  corridorWidthMeters: z.coerce.number().int().min(100).max(50_000).optional(),

  /** The user's patience, in minutes. Clamped to the configured ceiling (§22). */
  maxDetourMinutes: z.coerce.number().int().min(1).max(600).optional(),

  /**
   * Empty means every category is eligible (§23). Bounded so the filter itself cannot
   * become the expensive part of the query (§82).
   */
  categories: z.array(z.string().regex(CATEGORY_ID_PATTERN)).max(MAX_CATEGORY_FILTERS).default([]),

  /** How many candidates to return. Clamped to the configured maximum. */
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type DiscoveryQueryBody = z.infer<typeof discoveryQuerySchema>;

/**
 * A discovery request after clamping, as the pipeline sees it.
 *
 * Every field is resolved: no optionals, no "use the default later". Clamping happens
 * once, at the edge, so no downstream stage has to wonder whether a limit was applied.
 */
export interface DiscoveryQuery {
  readonly origin: { latitude: number; longitude: number; placeId?: string | undefined };
  readonly destination: { latitude: number; longitude: number; placeId?: string | undefined };
  readonly corridorWidthMeters: number;
  readonly maxDetourSeconds: number;
  readonly categories: readonly string[];
  readonly limit: number;
}

/**
 * A Place that is effectively the origin or the destination is not a discovery.
 *
 * The traveller is already going there. 150 m is generous enough to absorb a Place
 * pinned at a car park rather than an entrance, and tight enough that a genuinely
 * different Place on the same block still qualifies (§24).
 */
export const ENDPOINT_COINCIDENCE_METERS = 150;

/**
 * Progress below this, or above its complement, is at the ends of the journey.
 *
 * Not a scoring concern — the policy already handles placement — but a filter: a Place
 * 1% along the route is where the traveller is standing, and calling it a discovery
 * "along the way" is not true (§31).
 */
export const MINIMUM_ROUTE_PROGRESS = 0.02;
