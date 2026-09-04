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

  calculateRoute(request: RoutingRequest): Promise<RoutingResult> {
    this.calls += 1;
    this.requests.push(request);

    const failure = this.failure;
    if (failure !== null) return Promise.reject(failure);

    return Promise.resolve({
      geometry: this.geometry,
      metrics: {
        distanceMeters: this.distanceMeters,
        durationSeconds: this.durationSeconds,
      },
      legs: [
        {
          distanceMeters: this.distanceMeters,
          durationSeconds: this.durationSeconds,
          summary: 'BR-101',
        },
      ],
      provider: { name: 'fake', latencyMs: 1 },
    });
  }
}
