import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../../../infrastructure/config/app-config.js';
import { assertRoutableEndpoints } from '../domain/route-request.js';
import { boundsOf, type Route, type RoutePoint } from '../domain/route.js';
import {
  ROUTING_PROVIDER,
  RoutingProfile,
  type RoutingProvider,
} from '../domain/routing-provider.js';
import { CorridorRepository } from '../infrastructure/corridor.repository.js';

export interface CalculateRouteInput {
  origin: RoutePoint;
  destination: RoutePoint;
  /** Intermediate points, visited in the order given (PR-05). */
  waypoints?: readonly RoutePoint[] | undefined;
  /** Half-width of the corridor. Clamped to the configured maximum. */
  corridorWidthMeters?: number | undefined;
  /** Whether to derive and return the corridor at all. */
  includeCorridor: boolean;
}

/**
 * Calculates a route (§12, §17, §18).
 *
 * Depends on the [RoutingProvider] port, never on a vendor — which is what makes a
 * deterministic provider substitutable in tests without touching this file (§65).
 *
 * **Nothing is persisted.** A route between two points is a pure function of those
 * points and the road network; storing one would be a cache with no eviction policy
 * and no consumer. When PR-05 introduces Trails, a Trail will snapshot its own route
 * — which is a different thing, owned by a different domain (§48).
 */
@Injectable()
export class CalculateRouteUseCase {
  constructor(
    @Inject(ROUTING_PROVIDER) private readonly provider: RoutingProvider,
    private readonly corridors: CorridorRepository,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CalculateRouteUseCase.name);
  }

  async execute(input: CalculateRouteInput): Promise<Route> {
    /* Rejected before any upstream call, so a degenerate or nonsensical pair costs
       nothing (§55, §56). */
    assertRoutableEndpoints(input.origin, input.destination);

    const startedAt = performance.now();
    const result = await this.provider.calculateRoute({
      origin: input.origin,
      destination: input.destination,
      waypoints: input.waypoints,
      profile: RoutingProfile.DRIVING,
    });

    /* Bounds are computed from the geometry rather than taken from the provider, so
       they always describe the line that will actually be drawn (§17). */
    const bounds = boundsOf(result.geometry);

    const corridorWidth = this.resolveCorridorWidth(input.corridorWidthMeters);
    const corridor = input.includeCorridor
      ? await this.corridors.buildCorridor(result.geometry, corridorWidth)
      : null;

    const totalMs = Math.round(performance.now() - startedAt);

    /* Upstream and internal time are recorded separately, so a slow route is
       attributable rather than blamed on whichever layer is easiest to suspect (§60).
       No coordinates are logged: a route request is a statement about where someone
       is going (§58). */
    this.logger.info(
      {
        event: 'routing.calculate.success',
        provider: result.provider.name,
        providerLatencyMs: result.provider.latencyMs,
        internalMs: totalMs - result.provider.latencyMs,
        distanceBucketKm: distanceBucketKm(result.metrics.distanceMeters),
        waypointCount: input.waypoints?.length ?? 0,
        geometryPoints: result.geometry.coordinates.length,
        corridorIncluded: corridor !== null,
      },
      'Route calculated',
    );

    return {
      origin: input.origin,
      destination: input.destination,
      geometry: result.geometry,
      metrics: result.metrics,
      bounds,
      legs: result.legs,
      corridor,
      provider: result.provider.name,
    };
  }

  private resolveCorridorWidth(requested: number | undefined): number {
    const { corridorDefaultMeters, corridorMaxMeters } = this.config.routing;
    if (requested === undefined) return corridorDefaultMeters;
    return Math.min(Math.max(requested, 100), corridorMaxMeters);
  }
}

/**
 * Buckets a distance for metrics.
 *
 * A raw distance would make every route its own metric series; a bucket keeps
 * cardinality bounded while still separating a city hop from a cross-country drive
 * (§59).
 */
export function distanceBucketKm(distanceMeters: number): string {
  const km = distanceMeters / 1000;
  if (km < 5) return '0-5';
  if (km < 25) return '5-25';
  if (km < 100) return '25-100';
  if (km < 500) return '100-500';
  return '500+';
}
