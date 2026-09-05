import type { RouteGeometry } from '../../src/modules/routing/domain/route.js';
import type {
  RoutingProvider,
  RoutingRequest,
  RoutingResult,
} from '../../src/modules/routing/domain/routing-provider.js';

/**
 * A deterministic provider (§65).
 *
 * That this can be written without touching the domain, the use case or the
 * controller is the evidence that the port is a real boundary rather than decoration:
 * nothing above `infrastructure/` knows a vendor exists.
 */
export class FakeRoutingProvider implements RoutingProvider {
  /** Fixed geometry, so assertions about bounds and corridors are exact. */
  geometry: RouteGeometry = {
    type: 'LineString',
    coordinates: [
      [-34.8711, -8.0631],
      [-34.86, -7.98],
      [-34.85, -7.85],
      [-34.84, -7.6],
      [-34.85, -7.4],
      [-34.8631, -7.115],
    ],
  };

  distanceMeters = 105_060;
  durationSeconds = 6_480;

  /** Set to make the next call fail with a normalised routing error. */
  failure: Error | null = null;

  calls = 0;
  readonly requests: RoutingRequest[] = [];

  /**
   * Extra metres and seconds per waypoint (PR-05).
   *
   * Makes a composed route measurably longer than the base one, so a test can assert
   * that adding a stop actually changed the snapshot rather than merely that a call
   * happened.
   */
  metresPerWaypoint = 8_000;
  secondsPerWaypoint = 600;

  calculateRoute(request: RoutingRequest): Promise<RoutingResult> {
    this.calls += 1;
    this.requests.push(request);

    const failure = this.failure;
    if (failure !== null) return Promise.reject(failure);

    const waypoints = request.waypoints ?? [];
    const distanceMeters = this.distanceMeters + waypoints.length * this.metresPerWaypoint;
    const durationSeconds = this.durationSeconds + waypoints.length * this.secondsPerWaypoint;

    /* A route has one fewer legs than it has points, which is what the real provider
       returns and what a caller counting legs will assume. */
    const legCount = waypoints.length + 1;

    return Promise.resolve({
      geometry: this.geometry,
      metrics: { distanceMeters, durationSeconds },
      legs: Array.from({ length: legCount }, () => ({
        distanceMeters: Math.round(distanceMeters / legCount),
        durationSeconds: Math.round(durationSeconds / legCount),
        summary: 'BR-101',
      })),
      provider: { name: 'fake', latencyMs: 1 },
    });
  }
}
