import { describe, expect, it } from 'vitest';
import { PlaceProvenance } from '../../places/domain/place.js';
import { RelevanceReason, compareCandidates, type RouteCandidate } from './route-candidate.js';
import {
  PLACEMENT_EDGE_BAND,
  RELEVANCE_WEIGHTS_V1,
  RouteRelevancePolicyV1,
  scoreCandidate,
  type RelevanceContext,
  type RelevanceSignals,
} from './route-relevance.js';

/**
 * The ranking policy (§25–§34, §72, §73).
 *
 * A score nobody can predict is a score nobody can defend, so these tests assert
 * *properties* — monotonicity, bounds, determinism, tie-breaking — rather than
 * memorised numbers. A weight change should break a property test only when it
 * changes the behaviour the property describes.
 */
describe('RouteRelevancePolicyV1', () => {
  const policy = new RouteRelevancePolicyV1();

  const context: RelevanceContext = {
    maxDetourSeconds: 1_800,
    corridorWidthMeters: 5_000,
  };

  const signals = (overrides: Partial<RelevanceSignals> = {}): RelevanceSignals => ({
    place: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Mirante',
      categoryId: 'NATURE',
      latitude: -7.85,
      longitude: -34.85,
      provenance: PlaceProvenance.COMMUNITY,
    },
    distanceFromRouteMeters: 1_000,
    routeProgress: 0.5,
    detourDistanceMeters: 3_000,
    detourDurationSeconds: 300,
    ...overrides,
  });

  describe('version', () => {
    it('names itself, so a ranking can be attributed to a policy (§36)', () => {
      expect(policy.version).toBe('v1');
    });
  });

  describe('bounds (§27)', () => {
    it('stays within [0, 1] for the best imaginable candidate', () => {
      const verdict = policy.evaluate(
        signals({ detourDurationSeconds: 0, distanceFromRouteMeters: 0, routeProgress: 0.5 }),
        context,
      );

      expect(verdict.score).toBe(1);
    });

    it('stays within [0, 1] for the worst imaginable candidate', () => {
      const verdict = policy.evaluate(
        signals({
          detourDurationSeconds: 999_999,
          distanceFromRouteMeters: 999_999,
          routeProgress: 0,
        }),
        context,
      );

      expect(verdict.score).toBe(0);
    });

    /* A cheap stand-in for property-based testing: a wide sweep of the input space
       without adding a framework for it (§73). */
    it('stays within [0, 1] across a swept input space', () => {
      for (let detour = 0; detour <= 3_600; detour += 97) {
        for (let distance = 0; distance <= 10_000; distance += 613) {
          for (let progress = 0; progress <= 1; progress += 0.07) {
            const verdict = policy.evaluate(
              signals({
                detourDurationSeconds: detour,
                distanceFromRouteMeters: distance,
                routeProgress: progress,
              }),
              context,
            );

            expect(verdict.score).toBeGreaterThanOrEqual(0);
            expect(verdict.score).toBeLessThanOrEqual(1);
          }
        }
      }
    });

    it('survives a non-finite signal rather than producing NaN', () => {
      const verdict = policy.evaluate(
        signals({ detourDurationSeconds: Number.NaN, distanceFromRouteMeters: Infinity }),
        context,
      );

      expect(Number.isFinite(verdict.score)).toBe(true);
      expect(verdict.score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('detour monotonicity (§29, §72)', () => {
    it('prefers a smaller detour when everything else is equal', () => {
      const scoreFor = (seconds: number): number =>
        policy.evaluate(signals({ detourDurationSeconds: seconds }), context).score;

      const fiveMinutes = scoreFor(300);
      const twentyMinutes = scoreFor(1_200);
      const fortyMinutes = scoreFor(2_400);

      expect(fiveMinutes).toBeGreaterThan(twentyMinutes);
      expect(twentyMinutes).toBeGreaterThan(fortyMinutes);
    });

    it('is monotonic across the whole detour range, not just at the samples', () => {
      let previous = Number.POSITIVE_INFINITY;

      for (let seconds = 0; seconds <= 1_800; seconds += 30) {
        const score = policy.evaluate(signals({ detourDurationSeconds: seconds }), context).score;
        expect(score).toBeLessThanOrEqual(previous);
        previous = score;
      }
    });

    it('resolves a one-minute difference rather than rounding it away', () => {
      const a = policy.evaluate(signals({ detourDurationSeconds: 300 }), context).score;
      const b = policy.evaluate(signals({ detourDurationSeconds: 360 }), context).score;

      expect(a).toBeGreaterThan(b);
    });

    it('reads the same detour differently against a different patience ceiling', () => {
      const strict = policy.evaluate(signals({ detourDurationSeconds: 600 }), {
        ...context,
        maxDetourSeconds: 900,
      }).score;
      const relaxed = policy.evaluate(signals({ detourDurationSeconds: 600 }), {
        ...context,
        maxDetourSeconds: 7_200,
      }).score;

      /* Ten minutes is most of a fifteen-minute budget and a rounding error in a
         two-hour one. The score has to reflect that or the ceiling means nothing. */
      expect(relaxed).toBeGreaterThan(strict);
    });
  });

  describe('proximity (§30)', () => {
    it('prefers a closer place when detour and placement are equal', () => {
      const near = policy.evaluate(signals({ distanceFromRouteMeters: 200 }), context).score;
      const far = policy.evaluate(signals({ distanceFromRouteMeters: 4_500 }), context).score;

      expect(near).toBeGreaterThan(far);
    });

    it('does not let proximity outweigh a much better detour', () => {
      /* The premise of the whole feature: 2 km away but 25 minutes of road is worse
         than 4 km away and 7 minutes (§1). */
      const closeButSlow = policy.evaluate(
        signals({ distanceFromRouteMeters: 2_000, detourDurationSeconds: 1_500 }),
        context,
      ).score;
      const fartherButQuick = policy.evaluate(
        signals({ distanceFromRouteMeters: 4_000, detourDurationSeconds: 420 }),
        context,
      ).score;

      expect(fartherButQuick).toBeGreaterThan(closeButSlow);
    });

    it('weights detour above proximity by construction', () => {
      expect(RELEVANCE_WEIGHTS_V1.detourEfficiency).toBeGreaterThan(RELEVANCE_WEIGHTS_V1.proximity);
    });

    it('has weights that sum to one, so the score is bounded by construction', () => {
      const total =
        RELEVANCE_WEIGHTS_V1.detourEfficiency +
        RELEVANCE_WEIGHTS_V1.proximity +
        RELEVANCE_WEIGHTS_V1.placement;

      expect(total).toBeCloseTo(1, 10);
    });
  });

  describe('route placement (§31)', () => {
    it('penalises a place at the very start of the journey', () => {
      const atStart = policy.evaluate(signals({ routeProgress: 0.02 }), context).score;
      const wellAlong = policy.evaluate(signals({ routeProgress: 0.5 }), context).score;

      expect(atStart).toBeLessThan(wellAlong);
    });

    it('penalises a place at the very end symmetrically', () => {
      const atStart = policy.evaluate(signals({ routeProgress: 0.05 }), context).score;
      const atEnd = policy.evaluate(signals({ routeProgress: 0.95 }), context).score;

      expect(atStart).toBeCloseTo(atEnd, 10);
    });

    it('does not favour the exact middle over anywhere else in the middle', () => {
      const quarter = policy.evaluate(signals({ routeProgress: 0.25 }), context).score;
      const middle = policy.evaluate(signals({ routeProgress: 0.5 }), context).score;
      const threeQuarters = policy.evaluate(signals({ routeProgress: 0.75 }), context).score;

      expect(quarter).toBe(middle);
      expect(threeQuarters).toBe(middle);
    });

    it('reaches full placement value at the edge of the band', () => {
      const atBand = policy.evaluate(
        signals({ routeProgress: PLACEMENT_EDGE_BAND }),
        context,
      ).score;
      const middle = policy.evaluate(signals({ routeProgress: 0.5 }), context).score;

      expect(atBand).toBe(middle);
    });
  });

  describe('signals deliberately not used (§32, §33)', () => {
    it('scores a COMMUNITY place identically to a SYSTEM one', () => {
      const community = policy.evaluate(
        signals({ place: { ...signals().place, provenance: PlaceProvenance.COMMUNITY } }),
        context,
      );
      const system = policy.evaluate(
        signals({ place: { ...signals().place, provenance: PlaceProvenance.SYSTEM } }),
        context,
      );

      /* Provenance records where a Place came from, not whether it is any good.
         A bonus here would quietly demote everything the community contributed. */
      expect(community.score).toBe(system.score);
    });

    it('ignores the category entirely', () => {
      const nature = policy.evaluate(
        signals({ place: { ...signals().place, categoryId: 'NATURE' } }),
        context,
      );
      const food = policy.evaluate(
        signals({ place: { ...signals().place, categoryId: 'FOOD' } }),
        context,
      );

      expect(nature.score).toBe(food.score);
    });
  });

  describe('determinism (§38, §72)', () => {
    it('returns an identical score for identical inputs', () => {
      const first = policy.evaluate(signals(), context);
      const second = policy.evaluate(signals(), context);

      expect(second.score).toBe(first.score);
      expect(second.reasons).toEqual(first.reasons);
    });

    it('returns an identical score across policy instances', () => {
      const other = new RouteRelevancePolicyV1();

      expect(other.evaluate(signals(), context).score).toBe(
        policy.evaluate(signals(), context).score,
      );
    });
  });

  describe('reasons (§34)', () => {
    it('calls a place on the line ON_ROUTE', () => {
      const verdict = policy.evaluate(signals({ distanceFromRouteMeters: 120 }), context);

      expect(verdict.reasons).toContain(RelevanceReason.ON_ROUTE);
      expect(verdict.reasons).not.toContain(RelevanceReason.VERY_CLOSE_TO_ROUTE);
    });

    it('calls a nearby place VERY_CLOSE_TO_ROUTE', () => {
      const verdict = policy.evaluate(signals({ distanceFromRouteMeters: 800 }), context);

      expect(verdict.reasons).toContain(RelevanceReason.VERY_CLOSE_TO_ROUTE);
    });

    it('says nothing about proximity for a distant place', () => {
      const verdict = policy.evaluate(signals({ distanceFromRouteMeters: 4_000 }), context);

      expect(verdict.reasons).not.toContain(RelevanceReason.ON_ROUTE);
      expect(verdict.reasons).not.toContain(RelevanceReason.VERY_CLOSE_TO_ROUTE);
    });

    it('separates a low detour from a moderate one', () => {
      expect(policy.evaluate(signals({ detourDurationSeconds: 240 }), context).reasons).toContain(
        RelevanceReason.LOW_DETOUR,
      );
      expect(policy.evaluate(signals({ detourDurationSeconds: 700 }), context).reasons).toContain(
        RelevanceReason.MODERATE_DETOUR,
      );
      expect(
        policy.evaluate(signals({ detourDurationSeconds: 1_500 }), context).reasons,
      ).not.toContain(RelevanceReason.MODERATE_DETOUR);
    });

    it('always says something about where along the route the place sits', () => {
      expect(policy.evaluate(signals({ routeProgress: 0.05 }), context).reasons).toContain(
        RelevanceReason.EARLY_IN_ROUTE,
      );
      expect(policy.evaluate(signals({ routeProgress: 0.5 }), context).reasons).toContain(
        RelevanceReason.GOOD_ROUTE_POSITION,
      );
      expect(policy.evaluate(signals({ routeProgress: 0.95 }), context).reasons).toContain(
        RelevanceReason.LATE_IN_ROUTE,
      );
    });

    it('never returns an empty explanation', () => {
      for (let progress = 0; progress <= 1; progress += 0.05) {
        const verdict = policy.evaluate(signals({ routeProgress: progress }), context);
        expect(verdict.reasons.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('compareCandidates (§38)', () => {
  const candidate = (overrides: Partial<RouteCandidate>): RouteCandidate => ({
    place: {
      id: 'b',
      name: 'Somewhere',
      categoryId: 'FOOD',
      latitude: -7.85,
      longitude: -34.85,
      provenance: PlaceProvenance.COMMUNITY,
    },
    distanceFromRouteMeters: 1_000,
    routeProgress: 0.5,
    detourDistanceMeters: 3_000,
    detourDurationSeconds: 300,
    relevanceScore: 0.5,
    relevanceReasons: [],
    ...overrides,
  });

  it('orders by score, descending', () => {
    const better = candidate({ relevanceScore: 0.9 });
    const worse = candidate({ relevanceScore: 0.4 });

    expect([worse, better].sort(compareCandidates)[0]).toBe(better);
  });

  it('breaks a score tie on the shorter detour', () => {
    const quick = candidate({ relevanceScore: 0.5, detourDurationSeconds: 120 });
    const slow = candidate({ relevanceScore: 0.5, detourDurationSeconds: 900 });

    expect([slow, quick].sort(compareCandidates)[0]).toBe(quick);
  });

  it('breaks a full tie on place id, so ordering never wobbles', () => {
    const first = candidate({ place: { ...candidate({}).place, id: 'aaa' } });
    const second = candidate({ place: { ...candidate({}).place, id: 'zzz' } });

    expect([second, first].sort(compareCandidates)[0]).toBe(first);
    expect([first, second].sort(compareCandidates)[0]).toBe(first);
  });

  it('produces the same order however the input was shuffled', () => {
    const candidates = [
      candidate({ place: { ...candidate({}).place, id: 'c' }, relevanceScore: 0.5 }),
      candidate({ place: { ...candidate({}).place, id: 'a' }, relevanceScore: 0.5 }),
      candidate({ place: { ...candidate({}).place, id: 'b' }, relevanceScore: 0.9 }),
    ];

    const forwards = [...candidates].sort(compareCandidates).map((c) => c.place.id);
    const backwards = [...candidates]
      .reverse()
      .sort(compareCandidates)
      .map((c) => c.place.id);

    expect(forwards).toEqual(['b', 'a', 'c']);
    expect(backwards).toEqual(forwards);
  });
});

describe('scoreCandidate', () => {
  it('carries the spatial and detour facts through untouched', () => {
    const policy = new RouteRelevancePolicyV1();
    const result = scoreCandidate(
      policy,
      {
        place: {
          id: 'x',
          name: 'Mirante',
          categoryId: 'NATURE',
          latitude: -7.85,
          longitude: -34.85,
          provenance: PlaceProvenance.COMMUNITY,
        },
        distanceFromRouteMeters: 1_234,
        routeProgress: 0.42,
      },
      { detourDistanceMeters: 3_400, detourDurationSeconds: 420 },
      { maxDetourSeconds: 1_800, corridorWidthMeters: 5_000 },
    );

    expect(result.distanceFromRouteMeters).toBe(1_234);
    expect(result.detourDurationSeconds).toBe(420);
    expect(result.routeProgress).toBe(0.42);
    expect(result.relevanceScore).toBeGreaterThan(0);
    expect(result.relevanceReasons.length).toBeGreaterThan(0);
  });
});
