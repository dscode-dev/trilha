import {
  RelevanceReason,
  type DetourCost,
  type RouteCandidate,
  type SpatialCandidate,
} from './route-candidate.js';

/**
 * How much a Place is worth considering *on this route* (§7, §25, §26).
 *
 * The question this answers is deliberately narrow:
 *
 *   "How well does this place fit this journey?"
 *
 * and emphatically not "is this a good place?". Trilha has no basis for the second
 * question — there are no ratings, no reviews and no votes in the product yet — and
 * inventing a proxy for popularity would be fabricating a signal (§87).
 *
 * Deterministic, explicit, and testable. No model, no learned weights, no embeddings
 * (§86): a ranking a user might disagree with should be one an engineer can explain
 * line by line.
 */

/** Signals available to a policy. Extended, not replaced, when new domains land (§88). */
export interface RelevanceSignals extends SpatialCandidate, DetourCost {}

/** What "far" and "long" mean for this particular request. */
export interface RelevanceContext {
  /** The user's own patience ceiling: the same detour means different things at 15 and 120 minutes. */
  readonly maxDetourSeconds: number;
  /** The corridor half-width, which is what "close to the route" is measured against. */
  readonly corridorWidthMeters: number;
}

export interface RelevanceVerdict {
  readonly score: number;
  readonly reasons: readonly RelevanceReason[];
}

export interface RouteRelevancePolicy {
  readonly version: string;
  evaluate(signals: RelevanceSignals, context: RelevanceContext): RelevanceVerdict;
}

/* ---- Policy v1 ------------------------------------------------------------ */

/**
 * Weights, stated once (§37).
 *
 * They sum to 1, so the score is bounded by construction rather than by a clamp at
 * the end — which means a future component cannot silently push results past 1.
 */
export const RELEVANCE_WEIGHTS_V1 = {
  /**
   * Detour dominates, because it is the only signal here measured in the unit the
   * user actually spends (§29). A place 2 km off the line but 25 minutes away by road
   * is worse than one 4 km off the line and 7 minutes away, and only this term knows
   * the difference.
   */
  detourEfficiency: 0.6,
  /**
   * Proximity is secondary and stays that way (§30). Before detour existed it was the
   * only thing available; now that real road cost is measured, straight-line closeness
   * is a weak proxy that must not override the strong signal.
   */
  proximity: 0.25,
  /** Placement only avoids the ends; it does not reward the middle (§31). */
  placement: 0.15,
} as const;

/**
 * How near an end of the route counts as "barely a discovery".
 *
 * A place 2% into the journey is somewhere the traveller is leaving from, not
 * something found along the way. The ramp reaches full value at 15%, and is flat for
 * the entire middle — so nothing is nudged toward the centre for its own sake (§31).
 */
export const PLACEMENT_EDGE_BAND = 0.15;

/** Reason thresholds. Presentation reads these codes; it never re-derives them. */
export const ON_ROUTE_METERS = 250;
export const VERY_CLOSE_METERS = 1_000;
export const LOW_DETOUR_SECONDS = 300;
export const MODERATE_DETOUR_SECONDS = 900;

/**
 * The V1 ranking policy.
 *
 * ```
 * score = 0.60 · detourEfficiency
 *       + 0.25 · proximity
 *       + 0.15 · placement
 *
 * detourEfficiency = 1 − clamp(detourSeconds      / maxDetourSeconds,   0, 1)
 * proximity        = 1 − clamp(distanceFromRoute  / corridorWidth,      0, 1)
 * placement        =     clamp(min(p, 1 − p)      / 0.15,               0, 1)
 * ```
 *
 * **What is deliberately absent.** Provenance contributes nothing: it records where a
 * Place came from, not whether it is any good, and giving `SYSTEM` a bonus would
 * quietly demote everything the community contributed (§32). Description length
 * contributes nothing either — it would rank a verbose entry above a better-placed one
 * and call that quality (§33). Neither earns its place, so neither is in the formula.
 */
export class RouteRelevancePolicyV1 implements RouteRelevancePolicy {
  readonly version = 'v1';

  evaluate(signals: RelevanceSignals, context: RelevanceContext): RelevanceVerdict {
    const detourEfficiency =
      1 - clamp01(signals.detourDurationSeconds / Math.max(context.maxDetourSeconds, 1));
    const proximity =
      1 - clamp01(signals.distanceFromRouteMeters / Math.max(context.corridorWidthMeters, 1));
    const placement = clamp01(
      Math.min(signals.routeProgress, 1 - signals.routeProgress) / PLACEMENT_EDGE_BAND,
    );

    const raw =
      RELEVANCE_WEIGHTS_V1.detourEfficiency * detourEfficiency +
      RELEVANCE_WEIGHTS_V1.proximity * proximity +
      RELEVANCE_WEIGHTS_V1.placement * placement;

    return {
      /* Four decimals: fine enough that a one-second detour difference still separates
         two candidates, coarse enough that the wire value is readable. */
      score: Math.round(clamp01(raw) * 10_000) / 10_000,
      reasons: reasonsFor(signals),
    };
  }
}

/**
 * Explains the candidate in codes (§34).
 *
 * Ordered from most to least specific, so a client that shows only the first has the
 * most informative one.
 */
function reasonsFor(signals: RelevanceSignals): RelevanceReason[] {
  const reasons: RelevanceReason[] = [];

  if (signals.distanceFromRouteMeters <= ON_ROUTE_METERS) {
    reasons.push(RelevanceReason.ON_ROUTE);
  } else if (signals.distanceFromRouteMeters <= VERY_CLOSE_METERS) {
    reasons.push(RelevanceReason.VERY_CLOSE_TO_ROUTE);
  }

  if (signals.detourDurationSeconds <= LOW_DETOUR_SECONDS) {
    reasons.push(RelevanceReason.LOW_DETOUR);
  } else if (signals.detourDurationSeconds <= MODERATE_DETOUR_SECONDS) {
    reasons.push(RelevanceReason.MODERATE_DETOUR);
  }

  if (signals.routeProgress < PLACEMENT_EDGE_BAND) {
    reasons.push(RelevanceReason.EARLY_IN_ROUTE);
  } else if (signals.routeProgress > 1 - PLACEMENT_EDGE_BAND) {
    reasons.push(RelevanceReason.LATE_IN_ROUTE);
  } else {
    reasons.push(RelevanceReason.GOOD_ROUTE_POSITION);
  }

  return reasons;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Applies a policy to a spatial candidate and its measured detour. */
export function scoreCandidate(
  policy: RouteRelevancePolicy,
  candidate: SpatialCandidate,
  detour: DetourCost,
  context: RelevanceContext,
): RouteCandidate {
  const verdict = policy.evaluate({ ...candidate, ...detour }, context);

  return {
    ...candidate,
    ...detour,
    relevanceScore: verdict.score,
    relevanceReasons: verdict.reasons,
  };
}

/** Injection token — a policy is an interface and has no runtime identity. */
export const ROUTE_RELEVANCE_POLICY = Symbol('RouteRelevancePolicy');
