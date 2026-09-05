import type { RouteBounds, RouteGeometry } from '../../routing/domain/route.js';

/**
 * Trail domain types (§6).
 *
 * A Trail is **not** a Route (constitution §Trail). A Route is what the road network
 * says about getting from A to B — geometry, distance, duration, computed on demand
 * and owned by nobody. A Trail is what a person decided: which places, in which order,
 * deliberately saved. Routing answers *how*; a Trail records *what was chosen*.
 *
 * Nothing here is social. No visibility, no slug, no counts: publication is a later
 * PR with rules of its own, and a field reserved for it now is an invitation to fill
 * it with something that has none (§72).
 */

export const TrailStatus = {
  /** Being composed. The only state a Trail is created in. */
  DRAFT: 'DRAFT',
  /** The user said they were done. Not published — nobody else can see it (§45). */
  FINALIZED: 'FINALIZED',
  /** Finished with, kept but not listed by default. */
  ARCHIVED: 'ARCHIVED',
} as const;

export type TrailStatus = (typeof TrailStatus)[keyof typeof TrailStatus];

/**
 * Where a stop came from (§11).
 *
 * Provenance of the composition, never a quality signal and never an input to a
 * ranking. `AI` is absent because nothing can produce it yet.
 */
export const TrailStopSource = {
  DISCOVERY: 'DISCOVERY',
  SEARCH: 'SEARCH',
  MANUAL: 'MANUAL',
} as const;

export type TrailStopSource = (typeof TrailStopSource)[keyof typeof TrailStopSource];

export const TRAIL_STOP_SOURCES: readonly TrailStopSource[] = Object.values(TrailStopSource);

/**
 * One end of a Trail, snapshotted onto it (§9).
 *
 * A Trail's endpoints need not be Places — "from where I am now" is a perfectly good
 * origin — so the coordinate is the truth and `placeId` is recorded only when one was
 * chosen. `label` preserves what the user was looking at when they chose it.
 */
export interface TrailEndpoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly placeId: string | null;
  readonly label: string | null;
}

/**
 * A stop, which is always a resolved Place (constitution §Domain, §10).
 *
 * Never a loose coordinate and never free text: an unresolved stop cannot be shown,
 * searched, deduplicated or reused across Trails, and admitting one would make every
 * consumer handle a case that should not exist.
 */
export interface TrailStop {
  readonly id: string;
  readonly placeId: string;
  /** 1-based and contiguous. Never derived from insertion time (§12). */
  readonly position: number;
  readonly source: TrailStopSource;
  /** Denormalised for display only; the Place remains the source of truth (§52). */
  readonly placeName: string;
  readonly placeCategoryId: string;
  readonly placeLatitude: number;
  readonly placeLongitude: number;
}

/**
 * What routing last said about a composition (§18, §20).
 *
 * Persisted so that opening a Trail tomorrow shows the same distance and the same line
 * as today. A road closure should not silently rewrite a journey someone saved.
 *
 * Provider-independent by construction: metres, seconds, GeoJSON and a bare provider
 * name. A raw Mapbox payload would make every saved Trail unreadable the day the
 * supplier changes.
 */
export interface TrailRouteSnapshot {
  readonly geometry: RouteGeometry;
  readonly bounds: RouteBounds;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly provider: string;
  readonly calculatedAt: Date;
  /**
   * The trail revision this snapshot describes (§24).
   *
   * Equal to the Trail's revision means the line matches the current composition. A
   * boolean `dirty` would carry the same bit and none of the evidence.
   */
  readonly revision: number;
}

/** A → B with no stops, so the app can state what the whole detour costs (§39). */
export interface TrailBaseRoute {
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly calculatedAt: Date;
}

export interface Trail {
  readonly id: string;
  readonly ownerUserId: string;
  readonly status: TrailStatus;
  readonly origin: TrailEndpoint;
  readonly destination: TrailEndpoint;
  readonly stops: readonly TrailStop[];
  readonly revision: number;
  readonly route: TrailRouteSnapshot | null;
  readonly baseRoute: TrailBaseRoute | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finalizedAt: Date | null;
}

/** Enough for a list row. Deliberately without geometry (§42, §80). */
export interface TrailSummary {
  readonly id: string;
  readonly status: TrailStatus;
  readonly originLabel: string | null;
  readonly destinationLabel: string | null;
  readonly stopCount: number;
  readonly distanceMeters: number | null;
  readonly durationSeconds: number | null;
  readonly revision: number;
  readonly updatedAt: Date;
}

/**
 * The most stops a Trail may hold (§14, §17).
 *
 * The binding constraint is the routing provider: the Mapbox Directions driving
 * profile accepts 25 coordinates per request, and origin and destination take two of
 * them, leaving 23. Fifteen sits deliberately below that ceiling — a margin for a
 * provider that publishes a smaller limit, and a UX bound besides, since a list of
 * twenty-three stops is no longer something a person reorders by dragging.
 *
 * Enforced in the application layer, which is where a caller gets a useful error.
 */
export const MAX_TRAIL_STOPS = 15;

/** True when the drawn route describes the composition as it now stands (§22, §24). */
export function isRouteCurrent(trail: Pick<Trail, 'revision' | 'route'>): boolean {
  return trail.route !== null && trail.route.revision === trail.revision;
}

/**
 * Extra distance and time the stops add, against the same endpoints with none (§38).
 *
 * Null when either snapshot is missing, rather than zero: "no detour" and "not
 * measured" are different claims, and rendering the second as the first would state a
 * fact Trilha does not have.
 */
export function trailDetour(
  trail: Pick<Trail, 'route' | 'baseRoute'>,
): { extraDistanceMeters: number; extraDurationSeconds: number } | null {
  const { route, baseRoute } = trail;
  if (route === null || baseRoute === null) return null;

  return {
    /* Clamped at zero: a provider can return a composed route marginally shorter than
       its own direct one, and a negative detour is not something to show a user. */
    extraDistanceMeters: Math.max(0, route.distanceMeters - baseRoute.distanceMeters),
    extraDurationSeconds: Math.max(0, route.durationSeconds - baseRoute.durationSeconds),
  };
}
