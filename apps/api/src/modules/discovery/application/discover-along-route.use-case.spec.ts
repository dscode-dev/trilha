import { beforeEach, describe, expect, it } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import { loadAppConfig, type AppConfig } from '../../../infrastructure/config/app-config.js';
import type { PlacesAlongRouteQuery } from '../../places/application/places-along-route.query.js';
import { CalculateRouteUseCase } from '../../routing/application/calculate-route.use-case.js';
import type { CorridorRepository } from '../../routing/infrastructure/corridor.repository.js';
import {
  RouteNotFoundError,
  RoutingProviderUnavailableError,
} from '../../routing/domain/routing-errors.js';
import { RelevanceReason } from '../domain/route-candidate.js';
import { RouteRelevancePolicyV1 } from '../domain/route-relevance.js';
import type { DiscoveryQuery } from '../domain/discovery-query.js';
import { DiscoverAlongRouteUseCase, resultBucket } from './discover-along-route.use-case.js';
import { FakeRoutingProvider } from '../../../../test/support/routing.js';
import {
  FakePlacesAlongRoute,
  FakeRouteCostProvider,
  alongRoutePlace,
} from '../../../../test/support/discovery.js';

/**
 * The discovery pipeline (§10, §71, §76).
 *
 * Exercised end to end with both ports faked, which is what makes the ordering
 * assertions meaningful: the point of the pipeline is that nothing expensive happens
 * before everything cheap has, and only a test that can count provider calls can
 * prove it.
 */
describe('DiscoverAlongRouteUseCase', () => {
  const env = {
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/trilha',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'PPMKe3xE1YHUiJgpEsYYPMOMy6R6zUKAPuOwUv3jS7c',
    IP_HASH_KEY: 'Yh0bJ4gGLxOaAr9OMPvBGEBWWJhBQXoflb0LBIsBnh4',
    MAPBOX_ROUTING_ACCESS_TOKEN: 'pk.a-token-that-is-never-used-here',
  };

  const origin = { latitude: -8.0631, longitude: -34.8711 };
  const destination = { latitude: -7.115, longitude: -34.8631 };

  const query = (overrides: Partial<DiscoveryQuery> = {}): DiscoveryQuery => ({
    origin,
    destination,
    corridorWidthMeters: 5_000,
    maxDetourSeconds: 1_800,
    categories: [],
    limit: 20,
    ...overrides,
  });

  let routing: FakeRoutingProvider;
  let places: FakePlacesAlongRoute;
  let costs: FakeRouteCostProvider;
  let logged: unknown[];
  let config: AppConfig;

  const build = (overrides: Record<string, string> = {}): DiscoverAlongRouteUseCase => {
    config = loadAppConfig({ ...env, ...overrides });

    const record = (payload: unknown): void => {
      logged.push(payload);
    };
    const logger = {
      setContext: () => undefined,
      warn: record,
      error: record,
      info: record,
      debug: record,
    } as unknown as PinoLogger;

    /* The real route use case with a fake provider, rather than a stubbed route: the
       boundary between discovery and routing is part of what is under test. */
    const calculateRoute = new CalculateRouteUseCase(
      routing,
      {} as unknown as CorridorRepository,
      config,
      logger,
    );

    return new DiscoverAlongRouteUseCase(
      calculateRoute,
      places as unknown as PlacesAlongRouteQuery,
      costs,
      new RouteRelevancePolicyV1(),
      config,
      logger,
    );
  };

  beforeEach(() => {
    routing = new FakeRoutingProvider();
    places = new FakePlacesAlongRoute();
    costs = new FakeRouteCostProvider();
    logged = [];
  });

  describe('pipeline order (§10)', () => {
    it('calculates the route itself rather than accepting one', async () => {
      places.rows = [alongRoutePlace()];

      await build().execute(query());

      expect(routing.calls).toBe(1);
      expect(routing.requests[0]?.origin).toEqual(origin);
    });

    it('searches Places along the geometry the route actually produced', async () => {
      places.rows = [alongRoutePlace()];

      await build().execute(query());

      const sent = JSON.parse(places.queries[0]?.routeGeoJson ?? '{}') as {
        coordinates: unknown[];
      };
      expect(sent.coordinates).toHaveLength(routing.geometry.coordinates.length);
    });

    it('spends nothing upstream when the corridor is empty', async () => {
      places.rows = [];

      const result = await build().execute(query());

      /* Spatial filtering is free; detour evaluation is not. An empty corridor must
         cost exactly one route calculation and nothing else (§10). */
      expect(costs.calls).toBe(0);
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics.providerCalls).toBe(0);
    });

    it('evaluates detours only for candidates that survived the spatial stage', async () => {
      places.rows = [
        alongRoutePlace({ categoryId: 'FOOD' }),
        alongRoutePlace({ categoryId: 'NATURE' }),
        alongRoutePlace({ categoryId: 'NATURE' }),
      ];

      await build().execute(query({ categories: ['NATURE'] }));

      expect(costs.requests[0]?.via).toHaveLength(2);
    });
  });

  describe('cost ceilings (§21, §83, §98)', () => {
    it('never evaluates more candidates than the configured maximum', async () => {
      places.rows = Array.from({ length: 60 }, (_, i) =>
        alongRoutePlace({ distanceFromRouteMeters: 100 + i * 10 }),
      );

      const result = await build({ DISCOVERY_MAX_DETOUR_CANDIDATES: '20' }).execute(query());

      const viaCount = costs.requests.reduce((total, r) => total + r.via.length, 0);
      expect(viaCount).toBe(20);
      expect(result.diagnostics.spatialCandidates).toBe(60);
    });

    it('makes one provider call when the batch fits, whatever the candidate count', async () => {
      places.rows = Array.from({ length: 60 }, (_, i) =>
        alongRoutePlace({ distanceFromRouteMeters: 100 + i * 10 }),
      );

      const result = await build().execute(query());

      /* The worst case for a whole discovery request is the route plus this: two
         upstream calls, regardless of how many Places sit near the route (§98). */
      expect(costs.calls).toBe(1);
      expect(result.diagnostics.providerCalls).toBe(1);
    });

    it('batches when the evaluation ceiling exceeds what one call carries', async () => {
      costs.maxViaPointsPerCall = 5;
      places.rows = Array.from({ length: 30 }, (_, i) =>
        alongRoutePlace({ distanceFromRouteMeters: 100 + i * 10 }),
      );

      await build({
        DISCOVERY_MAX_DETOUR_CANDIDATES: '20',
        DISCOVERY_MAX_SPATIAL_CANDIDATES: '100',
      }).execute(query());

      expect(costs.calls).toBe(4);
      expect(costs.requests.every((r) => r.via.length <= 5)).toBe(true);
    });

    it('holds provider calls to the configured concurrency', async () => {
      costs.maxViaPointsPerCall = 2;
      costs.latencyMs = 15;
      places.rows = Array.from({ length: 20 }, (_, i) =>
        alongRoutePlace({ distanceFromRouteMeters: 100 + i * 10 }),
      );

      await build({
        DISCOVERY_MAX_DETOUR_CANDIDATES: '20',
        DISCOVERY_PROVIDER_CONCURRENCY: '3',
      }).execute(query());

      expect(costs.calls).toBe(10);
      expect(costs.maxConcurrent).toBeLessThanOrEqual(3);
      expect(costs.maxConcurrent).toBeGreaterThan(1);
    });

    it('prefers the nearest candidates when it cannot afford them all', async () => {
      const near = alongRoutePlace({ distanceFromRouteMeters: 200 });
      const far = alongRoutePlace({ distanceFromRouteMeters: 4_800 });
      places.rows = [far, near];

      await build({ DISCOVERY_MAX_DETOUR_CANDIDATES: '1' }).execute(query());

      /* Distance is a weak predictor of detour — that is the premise of the feature —
         but it is the only signal available before paying for anything (§13). */
      expect(costs.requests[0]?.via).toHaveLength(1);
      expect(costs.requests[0]?.via[0]?.latitude).toBe(near.latitude);
    });
  });

  describe('eligibility (§24, §31)', () => {
    it('drops a Place at the very start of the journey', async () => {
      places.rows = [alongRoutePlace({ routeProgress: 0.005 })];

      const result = await build().execute(query());

      expect(result.candidates).toEqual([]);
      expect(costs.calls).toBe(0);
    });

    it('drops a Place at the very end of the journey', async () => {
      places.rows = [alongRoutePlace({ routeProgress: 0.995 })];

      const result = await build().execute(query());

      expect(result.candidates).toEqual([]);
    });

    it('drops a Place that is effectively the origin', async () => {
      places.rows = [
        alongRoutePlace({
          latitude: origin.latitude,
          longitude: origin.longitude,
          routeProgress: 0.4,
        }),
      ];

      const result = await build().execute(query());

      /* The traveller is already standing there; it is not a discovery. */
      expect(result.candidates).toEqual([]);
    });

    it('drops a Place that is effectively the destination', async () => {
      places.rows = [
        alongRoutePlace({
          latitude: destination.latitude,
          longitude: destination.longitude,
          routeProgress: 0.6,
        }),
      ];

      const result = await build().execute(query());

      expect(result.candidates).toEqual([]);
    });

    it('passes the category filter to the spatial query rather than filtering after', async () => {
      places.rows = [alongRoutePlace({ categoryId: 'FOOD' })];

      await build().execute(query({ categories: ['NATURE', 'FOOD'] }));

      expect(places.queries[0]?.categoryIds).toEqual(['NATURE', 'FOOD']);
    });

    it('treats an empty category list as every category', async () => {
      places.rows = [
        alongRoutePlace({ categoryId: 'FOOD' }),
        alongRoutePlace({ categoryId: 'NATURE' }),
      ];

      const result = await build().execute(query({ categories: [] }));

      expect(result.candidates).toHaveLength(2);
    });
  });

  describe('detour (§16, §17, §22)', () => {
    it('measures detour against the provider’s own baseline', async () => {
      const place = alongRoutePlace();
      places.rows = [place];
      costs.setDetour({ latitude: place.latitude, longitude: place.longitude }, 420);

      const result = await build().execute(query());

      expect(result.candidates[0]?.detourDurationSeconds).toBe(420);
      expect(result.candidates[0]?.detourDistanceMeters).toBe(420 * costs.metresPerSecond);
    });

    it('keeps detour distinct from distance from the route', async () => {
      const place = alongRoutePlace({ distanceFromRouteMeters: 1_200 });
      places.rows = [place];
      costs.setDetour({ latitude: place.latitude, longitude: place.longitude }, 900);

      const result = await build().execute(query());

      /* Conflating the two is the mistake the whole domain exists to avoid (§17). */
      expect(result.candidates[0]?.distanceFromRouteMeters).toBe(1_200);
      expect(result.candidates[0]?.detourDistanceMeters).not.toBe(1_200);
    });

    it('discards a candidate over the detour ceiling rather than ranking it low', async () => {
      const cheap = alongRoutePlace({ distanceFromRouteMeters: 500 });
      const expensive = alongRoutePlace({ distanceFromRouteMeters: 600 });
      places.rows = [cheap, expensive];
      costs.setDetour(cheap, 300);
      costs.setDetour(expensive, 5_400);

      const result = await build().execute(query({ maxDetourSeconds: 1_800 }));

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.place.id).toBe(cheap.id);
    });

    it('respects a tighter ceiling supplied by the caller', async () => {
      const place = alongRoutePlace();
      places.rows = [place];
      costs.setDetour(place, 900);

      const strict = await build().execute(query({ maxDetourSeconds: 600 }));
      const relaxed = await build().execute(query({ maxDetourSeconds: 1_800 }));

      expect(strict.candidates).toHaveLength(0);
      expect(relaxed.candidates).toHaveLength(1);
    });

    it('never reports a negative detour, even if a via journey measures shorter', async () => {
      const place = alongRoutePlace();
      places.rows = [place];
      costs.setDetour(place, -300);

      const result = await build().execute(query());

      expect(result.candidates[0]?.detourDurationSeconds).toBe(0);
      expect(result.candidates[0]?.detourDistanceMeters).toBe(0);
    });
  });

  describe('failure tolerance (§50, §51)', () => {
    it('drops an unreachable candidate and keeps the rest', async () => {
      const reachable = alongRoutePlace({ distanceFromRouteMeters: 400 });
      const unreachable = alongRoutePlace({ distanceFromRouteMeters: 500 });
      places.rows = [reachable, unreachable];
      costs.setDetour(reachable, 300);
      costs.setDetour(unreachable, null);

      const result = await build().execute(query());

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.place.id).toBe(reachable.id);
      /* The narrowing is reported rather than hidden (§51). */
      expect(result.diagnostics.spatialCandidates).toBe(2);
      expect(result.diagnostics.returnedCandidates).toBe(1);
    });

    it('fails the request when the base route cannot be calculated', async () => {
      routing.failure = new RouteNotFoundError();
      places.rows = [alongRoutePlace()];

      await expect(build().execute(query())).rejects.toThrow(RouteNotFoundError);
      expect(costs.calls).toBe(0);
    });

    it('fails the request when the cost provider is unavailable', async () => {
      costs.failure = new RoutingProviderUnavailableError();
      places.rows = [alongRoutePlace()];

      /* One unroutable place is information; a dead provider is an outage, and
         returning an empty list would report it as "nothing found" (§50). */
      await expect(build().execute(query())).rejects.toThrow(RoutingProviderUnavailableError);
    });

    it('never invents a detour for a candidate that was not evaluated', async () => {
      places.rows = Array.from({ length: 5 }, (_, i) =>
        alongRoutePlace({ distanceFromRouteMeters: 100 + i * 10 }),
      );

      const result = await build({ DISCOVERY_MAX_DETOUR_CANDIDATES: '2' }).execute(query());

      /* Guessing from straight-line distance would fabricate the one signal the
         feature exists to provide. */
      expect(result.candidates).toHaveLength(2);
    });
  });

  describe('ranking (§38)', () => {
    it('orders by relevance, not by distance from the route', async () => {
      const closeButSlow = alongRoutePlace({ distanceFromRouteMeters: 2_000 });
      const fartherButQuick = alongRoutePlace({ distanceFromRouteMeters: 4_000 });
      places.rows = [closeButSlow, fartherButQuick];
      costs.setDetour(closeButSlow, 1_500);
      costs.setDetour(fartherButQuick, 420);

      const result = await build().execute(query());

      expect(result.candidates[0]?.place.id).toBe(fartherButQuick.id);
    });

    it('returns the same order for the same inputs', async () => {
      places.rows = Array.from({ length: 6 }, (_, i) =>
        alongRoutePlace({ distanceFromRouteMeters: 500 + i * 100 }),
      );

      const first = await build().execute(query());
      const second = await build().execute(query());

      expect(second.candidates.map((c) => c.place.id)).toEqual(
        first.candidates.map((c) => c.place.id),
      );
    });

    it('honours the requested limit', async () => {
      places.rows = Array.from({ length: 15 }, (_, i) =>
        alongRoutePlace({ distanceFromRouteMeters: 200 + i * 100 }),
      );

      const result = await build().execute(query({ limit: 3 }));

      expect(result.candidates).toHaveLength(3);
      expect(result.diagnostics.returnedCandidates).toBe(3);
    });

    it('reports which policy produced the order', async () => {
      places.rows = [alongRoutePlace()];

      const result = await build().execute(query());

      expect(result.policyVersion).toBe('v1');
    });

    it('explains every candidate it returns', async () => {
      places.rows = Array.from({ length: 4 }, (_, i) =>
        alongRoutePlace({ distanceFromRouteMeters: 300 + i * 500 }),
      );

      const result = await build().execute(query());

      for (const candidate of result.candidates) {
        expect(candidate.relevanceReasons.length).toBeGreaterThan(0);
      }
    });

    it('marks a place on the line as ON_ROUTE', async () => {
      const place = alongRoutePlace({ distanceFromRouteMeters: 80 });
      places.rows = [place];
      costs.setDetour(place, 120);

      const result = await build().execute(query());

      expect(result.candidates[0]?.relevanceReasons).toContain(RelevanceReason.ON_ROUTE);
      expect(result.candidates[0]?.relevanceReasons).toContain(RelevanceReason.LOW_DETOUR);
    });
  });

  describe('privacy and observability (§53, §54)', () => {
    it('logs counts and timings, never coordinates', async () => {
      places.rows = [alongRoutePlace()];

      await build().execute(query());

      const serialised = JSON.stringify(logged);
      expect(serialised).toContain('discovery.request.success');
      expect(serialised).not.toContain('-34.8711');
      expect(serialised).not.toContain('-8.0631');
    });

    it('logs no place identity', async () => {
      const place = alongRoutePlace();
      places.rows = [place];

      await build().execute(query());

      expect(JSON.stringify(logged)).not.toContain(place.id);
      expect(JSON.stringify(logged)).not.toContain(place.name);
    });

    it('reports where the time went', async () => {
      places.rows = [alongRoutePlace()];

      const result = await build().execute(query());

      expect(result.diagnostics.spatialQueryMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.detourEvaluationMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.rankingMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.totalMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('resultBucket (§54)', () => {
  it('bounds metric cardinality instead of labelling with a raw count', () => {
    expect(resultBucket(0)).toBe('0');
    expect(resultBucket(3)).toBe('1-5');
    expect(resultBucket(12)).toBe('6-20');
    expect(resultBucket(90)).toBe('20+');
  });
});
