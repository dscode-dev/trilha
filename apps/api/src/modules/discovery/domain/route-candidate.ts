/**
 * Discovery domain types (§6, §7).
 *
 * A `RouteCandidate` is a Place *seen from a route*. It exists only for the duration
 * of one request and is never persisted (§6): the same Place is an excellent candidate
 * for one journey and irrelevant to the next, so the interesting value is a function
 * of three things — the Place, the route, and the policy — and belongs to none of them
 * alone.
 *
 * This is why `places.relevance_score` would be wrong (§7). A column on Place would
 * have to mean "relevant in general", which is not a claim Trilha can make or defend.
 */

import type { PlaceProvenance } from '../../places/domain/place.js';

/** The subset of a Place a candidate carries. Never a full PlaceDetail (§40). */
export interface CandidatePlace {
  readonly id: string;
  readonly name: string;
  readonly categoryId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly provenance: PlaceProvenance;
}

/**
 * A Place that survived the spatial filter, before any provider call.
 *
 * Split from [RouteCandidate] deliberately: everything here comes from PostGIS and is
 * free, everything added afterwards costs a metered request. Keeping the two shapes
 * distinct makes it impossible to write code that reads a detour which has not been
 * paid for.
 */
export interface SpatialCandidate {
  readonly place: CandidatePlace;
  /** Shortest distance from the Place to the route line, on the spheroid (§14). */
  readonly distanceFromRouteMeters: number;
  /** Where along the journey the Place sits: 0 at the origin, 1 at the destination. */
  readonly routeProgress: number;
}

/** What a detour actually costs, relative to the unmodified route (§17). */
export interface DetourCost {
  readonly detourDistanceMeters: number;
  readonly detourDurationSeconds: number;
}

export interface RouteCandidate extends SpatialCandidate, DetourCost {
  /** Normalised to [0, 1] by the policy named in [RouteRelevancePolicy.version]. */
  readonly relevanceScore: number;
  readonly relevanceReasons: readonly RelevanceReason[];
}

/**
 * Why a candidate is being shown (§34).
 *
 * Codes rather than sentences: the backend must not decide how a Brazilian user reads
 * "+7 minutes", and a provider's own phrasing must never reach a screen. The client
 * owns the wording (§35).
 */
export const RelevanceReason = {
  /** Effectively on the line — no meaningful diversion at all. */
  ON_ROUTE: 'ON_ROUTE',
  VERY_CLOSE_TO_ROUTE: 'VERY_CLOSE_TO_ROUTE',
  LOW_DETOUR: 'LOW_DETOUR',
  MODERATE_DETOUR: 'MODERATE_DETOUR',
  /** Comfortably along the journey rather than at either end. */
  GOOD_ROUTE_POSITION: 'GOOD_ROUTE_POSITION',
  EARLY_IN_ROUTE: 'EARLY_IN_ROUTE',
  LATE_IN_ROUTE: 'LATE_IN_ROUTE',
} as const;

export type RelevanceReason = (typeof RelevanceReason)[keyof typeof RelevanceReason];

export const RELEVANCE_REASONS: readonly RelevanceReason[] = Object.values(RelevanceReason);

/**
 * Orders candidates for presentation (§38).
 *
 * The tie-breaks are not decoration. Two Places with equal scores must come back in
 * the same order on every request, or a client that re-queries after a filter change
 * sees the list shuffle for no reason the user can perceive. `placeId` is the final
 * tie-break because it is the only value guaranteed to be unique and stable.
 */
export function compareCandidates(a: RouteCandidate, b: RouteCandidate): number {
  if (a.relevanceScore !== b.relevanceScore) return b.relevanceScore - a.relevanceScore;
  if (a.detourDurationSeconds !== b.detourDurationSeconds) {
    return a.detourDurationSeconds - b.detourDurationSeconds;
  }
  return a.place.id < b.place.id ? -1 : a.place.id > b.place.id ? 1 : 0;
}
