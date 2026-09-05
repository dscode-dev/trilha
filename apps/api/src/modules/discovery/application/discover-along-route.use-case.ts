import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../../../infrastructure/config/app-config.js';
import { PlacesAlongRouteQuery } from '../../places/application/places-along-route.query.js';
import { CalculateRouteUseCase } from '../../routing/application/calculate-route.use-case.js';
import { greatCircleMeters, type Route, type RoutePoint } from '../../routing/domain/route.js';
import {
  ENDPOINT_COINCIDENCE_METERS,
  MINIMUM_ROUTE_PROGRESS,
  type DiscoveryQuery,
} from '../domain/discovery-query.js';
import {
  ROUTE_COST_PROVIDER,
  type RouteCostProvider,
  type ViaCostResult,
} from '../domain/route-cost-provider.js';
import {
  compareCandidates,
  type CandidatePlace,
  type DetourCost,
  type RouteCandidate,
  type SpatialCandidate,
} from '../domain/route-candidate.js';
import {
  ROUTE_RELEVANCE_POLICY,
  scoreCandidate,
  type RouteRelevancePolicy,
} from '../domain/route-relevance.js';
import { chunk, mapWithConcurrency } from './concurrency.js';

/**
 * The discovery pipeline (§10).
 *
 * ```
 * Route  →  Spatial retrieval  →  Cheap filters  →  Detour  →  Score  →  Rank
 *          (PostGIS, free)                          (metered)
 * ```
 *
 * **The order is the whole design.** Everything free happens first, and the expensive
 * stage sees only what survived. Inverting any two steps — scoring before filtering,
 * or evaluating detours before the spatial cap — turns a fixed cost into one that
 * scales with how many Places happen to sit near the route, which is exactly the
 * property a metered dependency must not have (§10, §18).
 *
 * Nothing is persisted. A discovery is a question about where someone is going, and
 * the answer expires the moment they change their mind (§53).
 */

export interface DiscoveryResult {
  readonly route: Route;
  readonly policyVersion: string;
  readonly candidates: readonly RouteCandidate[];
  readonly diagnostics: DiscoveryDiagnostics;
}

/** How the funnel narrowed, and where the time went (§48, §54). */
export interface DiscoveryDiagnostics {
  readonly spatialCandidates: number;
  readonly evaluatedCandidates: number;
  readonly returnedCandidates: number;
  readonly providerCalls: number;
  readonly spatialQueryMs: number;
  readonly detourEvaluationMs: number;
  readonly rankingMs: number;
  readonly totalMs: number;
}

@Injectable()
export class DiscoverAlongRouteUseCase {
  constructor(
    private readonly calculateRoute: CalculateRouteUseCase,
    private readonly places: PlacesAlongRouteQuery,
    @Inject(ROUTE_COST_PROVIDER) private readonly costs: RouteCostProvider,
    @Inject(ROUTE_RELEVANCE_POLICY) private readonly policy: RouteRelevancePolicy,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DiscoverAlongRouteUseCase.name);
  }

  async execute(query: DiscoveryQuery): Promise<DiscoveryResult> {
    const startedAt = performance.now();

    /* The route comes from Trilha's own Routing Core, never from the caller (§9). It
       also validates the endpoints, so a degenerate pair is rejected before either
       provider is touched. */
    const route = await this.calculateRoute.execute({
      origin: query.origin,
      destination: query.destination,
      includeCorridor: false,
    });

    const spatialStartedAt = performance.now();
    const spatial = await this.retrieveSpatialCandidates(query, route);
    const spatialQueryMs = Math.round(performance.now() - spatialStartedAt);

    const detourStartedAt = performance.now();
    const { costs, providerCalls } = await this.evaluateDetours(query, spatial);
    const detourEvaluationMs = Math.round(performance.now() - detourStartedAt);

    const rankingStartedAt = performance.now();
    const candidates = this.rank(query, spatial, costs);
    const rankingMs = Math.round(performance.now() - rankingStartedAt);

    const diagnostics: DiscoveryDiagnostics = {
      spatialCandidates: spatial.length,
      evaluatedCandidates: costs.size,
      returnedCandidates: candidates.length,
      providerCalls,
      spatialQueryMs,
      detourEvaluationMs,
      rankingMs,
      totalMs: Math.round(performance.now() - startedAt),
    };

    /* Counts and timings only. No coordinates, no place ids, no user id: a discovery
       request states where someone intends to travel (§53, §54). */
    this.logger.info(
      {
        event: 'discovery.request.success',
        policyVersion: this.policy.version,
        categoryFilters: query.categories.length,
        resultBucket: resultBucket(candidates.length),
        ...diagnostics,
      },
      'Discovery completed',
    );

    return { route, policyVersion: this.policy.version, candidates, diagnostics };
  }

  /**
   * Everything PostGIS can answer for free (§11, §24).
   *
   * The cap is applied by the database, ordered by distance from the line. Distance is
   * a weak predictor of detour — that is the premise of the whole feature — but it is
   * the only signal available before paying for anything, and it is a far better
   * pre-filter than an arbitrary slice.
   */
  private async retrieveSpatialCandidates(
    query: DiscoveryQuery,
    route: Route,
  ): Promise<SpatialCandidate[]> {
    const rows = await this.places.execute({
      routeGeoJson: JSON.stringify(route.geometry),
      corridorWidthMeters: query.corridorWidthMeters,
      categoryIds: query.categories,
      limit: this.config.discovery.maxSpatialCandidates,
    });

    return rows
      .map((row) => ({
        place: {
          id: row.id,
          name: row.name,
          categoryId: row.categoryId,
          latitude: row.latitude,
          longitude: row.longitude,
          provenance: row.provenance,
        } satisfies CandidatePlace,
        distanceFromRouteMeters: row.distanceFromRouteMeters,
        routeProgress: clamp01(row.routeProgress),
      }))
      .filter((candidate) => this.isEligible(candidate, query));
  }

  /**
   * Filters that need no provider call (§24).
   *
   * A Place at the origin is not a discovery — the traveller is already there — and
   * neither is one at the destination. Both checks are cheap and both remove
   * candidates that would otherwise consume a slot in the metered batch.
   */
  private isEligible(candidate: SpatialCandidate, query: DiscoveryQuery): boolean {
    if (candidate.routeProgress < MINIMUM_ROUTE_PROGRESS) return false;
    if (candidate.routeProgress > 1 - MINIMUM_ROUTE_PROGRESS) return false;

    const point: RoutePoint = {
      latitude: candidate.place.latitude,
      longitude: candidate.place.longitude,
    };
    if (greatCircleMeters(point, query.origin) < ENDPOINT_COINCIDENCE_METERS) return false;
    if (greatCircleMeters(point, query.destination) < ENDPOINT_COINCIDENCE_METERS) return false;

    return true;
  }

  /**
   * The only stage that spends money (§18, §21, §49).
   *
   * Bounded twice over: by `maxDetourCandidates`, which decides how many are worth
   * paying for, and by the provider's own batch size, which decides how many calls
   * that takes. With the shipped defaults — 20 candidates, 23 via-points per matrix
   * call — the answer is one call, and the worst case for a whole discovery request is
   * two provider calls including the route itself (§98).
   */
  private async evaluateDetours(
    query: DiscoveryQuery,
    spatial: readonly SpatialCandidate[],
  ): Promise<{ costs: Map<string, DetourCost>; providerCalls: number }> {
    const costs = new Map<string, DetourCost>();
    if (spatial.length === 0) return { costs, providerCalls: 0 };

    const evaluated = spatial.slice(0, this.config.discovery.maxDetourCandidates);
    const batches = chunk(evaluated, this.costs.maxViaPointsPerCall);

    const results = await mapWithConcurrency(
      batches,
      this.config.discovery.providerConcurrency,
      (batch) =>
        this.costs.viaCosts({
          origin: query.origin,
          destination: query.destination,
          via: batch.map((candidate) => ({
            latitude: candidate.place.latitude,
            longitude: candidate.place.longitude,
          })),
        }),
    );

    batches.forEach((batch, batchIndex) => {
      const result: ViaCostResult | undefined = results[batchIndex];
      if (result === undefined) return;

      batch.forEach((candidate, viaIndex) => {
        const viaCost = result.via[viaIndex];
        /* The provider could not reach this place by road. That is an answer about the
           place, not a failure of the request, so it is dropped and the rest stand
           (§50). */
        if (viaCost == null) return;

        const detourDistanceMeters = Math.max(
          0,
          Math.round(viaCost.distanceMeters - result.baseline.distanceMeters),
        );
        const detourDurationSeconds = Math.max(
          0,
          Math.round(viaCost.durationSeconds - result.baseline.durationSeconds),
        );

        if (detourDurationSeconds > query.maxDetourSeconds) return;

        costs.set(candidate.place.id, { detourDistanceMeters, detourDurationSeconds });
      });
    });

    return { costs, providerCalls: batches.length };
  }

  /** Scores what survived, orders it deterministically, and cuts to the limit (§38). */
  private rank(
    query: DiscoveryQuery,
    spatial: readonly SpatialCandidate[],
    costs: ReadonlyMap<string, DetourCost>,
  ): RouteCandidate[] {
    const context = {
      maxDetourSeconds: query.maxDetourSeconds,
      corridorWidthMeters: query.corridorWidthMeters,
    };

    const scored: RouteCandidate[] = [];
    for (const candidate of spatial) {
      const detour = costs.get(candidate.place.id);
      /* No measured detour means no candidate. Guessing one from straight-line
         distance would be inventing the signal the feature exists to provide. */
      if (detour === undefined) continue;
      scored.push(scoreCandidate(this.policy, candidate, detour, context));
    }

    return scored.sort(compareCandidates).slice(0, query.limit);
  }
}

/** Bounded label for metrics: a raw count would be unbounded cardinality (§54). */
export function resultBucket(count: number): string {
  if (count === 0) return '0';
  if (count <= 5) return '1-5';
  if (count <= 20) return '6-20';
  return '20+';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
