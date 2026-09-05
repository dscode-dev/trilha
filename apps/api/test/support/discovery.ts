import type { RoutePoint } from '../../src/modules/routing/domain/route.js';
import type {
  AlongRouteQuery,
  PlaceAlongRouteRow,
} from '../../src/modules/places/application/places-along-route.query.js';
import type {
  RouteCostProvider,
  ViaCostRequest,
  ViaCostResult,
} from '../../src/modules/discovery/domain/route-cost-provider.js';

/**
 * A deterministic travel-cost provider (§71, §76).
 *
 * That this can be written against the port alone — no HTTP, no matrix shape, no
 * vendor vocabulary — is the evidence that `RouteCostProvider` is a real boundary and
 * not decoration (§20).
 *
 * Costs are scripted per coordinate rather than computed, so a test can say "this
 * place is a five-minute detour and that one is forty" and assert on the consequence
 * instead of on arithmetic.
 */
export class FakeRouteCostProvider implements RouteCostProvider {
  maxViaPointsPerCall = 23;

  baseline = { distanceMeters: 105_060, durationSeconds: 6_480 };

  /**
   * Detour seconds by `"lat,lng"`, added to the baseline.
   *
   * A coordinate with no entry gets [defaultDetourSeconds]; a coordinate mapped to
   * `null` is one the provider cannot reach at all.
   */
  readonly detoursByCoordinate = new Map<string, number | null>();
  defaultDetourSeconds = 600;

  /** Metres of extra road per second of extra time, so distances stay plausible. */
  metresPerSecond = 15;

  /** Set to make the next call fail with a normalised provider error. */
  failure: Error | null = null;

  calls = 0;
  readonly requests: ViaCostRequest[] = [];
  /** Highest number of calls in flight at once, so concurrency limits are provable. */
  maxConcurrent = 0;
  private inFlight = 0;
  /** Delay per call, so overlapping calls actually overlap. */
  latencyMs = 0;

  async viaCosts(request: ViaCostRequest): Promise<ViaCostResult> {
    this.calls += 1;
    this.requests.push(request);

    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);

    try {
      if (this.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      }

      const failure = this.failure;
      if (failure !== null) throw failure;

      return {
        baseline: this.baseline,
        via: request.via.map((point) => {
          const detour = this.detourFor(point);
          if (detour === null) return null;

          return {
            distanceMeters: this.baseline.distanceMeters + detour * this.metresPerSecond,
            durationSeconds: this.baseline.durationSeconds + detour,
          };
        }),
        provider: { name: 'fake-matrix', latencyMs: 1 },
      };
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Scripts a place's detour. `null` means the provider cannot reach it. */
  setDetour(point: { latitude: number; longitude: number }, seconds: number | null): void {
    this.detoursByCoordinate.set(coordinateKey(point), seconds);
  }

  private detourFor(point: RoutePoint): number | null {
    const scripted = this.detoursByCoordinate.get(coordinateKey(point));
    return scripted === undefined ? this.defaultDetourSeconds : scripted;
  }
}

function coordinateKey(point: { latitude: number; longitude: number }): string {
  return `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
}

/**
 * A scriptable stand-in for the Places spatial boundary.
 *
 * Built against `PlacesAlongRouteQuery`'s shape rather than the repository, because
 * that narrow read capability is the whole of what Discovery is allowed to use
 * (ADR-0001) — a fake that offered more would be testing a boundary that does not
 * exist.
 */
export class FakePlacesAlongRoute {
  rows: PlaceAlongRouteRow[] = [];
  calls = 0;
  readonly queries: AlongRouteQuery[] = [];

  execute(query: AlongRouteQuery): Promise<PlaceAlongRouteRow[]> {
    this.calls += 1;
    this.queries.push(query);

    /* The real query filters and caps in SQL; the fake mirrors just enough of that to
       keep tests about the pipeline rather than about SQL semantics. */
    const filtered =
      query.categoryIds.length === 0
        ? this.rows
        : this.rows.filter((row) => query.categoryIds.includes(row.categoryId));

    return Promise.resolve(
      [...filtered]
        .sort((a, b) => a.distanceFromRouteMeters - b.distanceFromRouteMeters)
        .slice(0, query.limit),
    );
  }
}

let placeCounter = 0;

/** A Place along the fixture route, at a given progress and offset. */
export function alongRoutePlace(overrides: Partial<PlaceAlongRouteRow> = {}): PlaceAlongRouteRow {
  placeCounter += 1;

  return {
    id: `00000000-0000-0000-0000-${String(placeCounter).padStart(12, '0')}`,
    name: `Place ${String(placeCounter)}`,
    categoryId: 'LANDMARK',
    /* Each fixture gets its own coordinate, so a scripted detour applies to one place
       and not to every place in the test. */
    latitude: -7.85 + placeCounter * 0.001,
    longitude: -34.85,
    provenance: 'COMMUNITY',
    distanceFromRouteMeters: 1_000,
    routeProgress: 0.5,
    ...overrides,
  };
}
