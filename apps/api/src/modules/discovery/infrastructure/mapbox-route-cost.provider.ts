import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../../../infrastructure/config/app-config.js';
import type { RouteMetrics, RoutePoint } from '../../routing/domain/route.js';
import {
  RoutingProviderRateLimitedError,
  RoutingProviderTimeoutError,
  RoutingProviderUnavailableError,
} from '../../routing/domain/routing-errors.js';
import type {
  RouteCostProvider,
  ViaCostRequest,
  ViaCostResult,
} from '../domain/route-cost-provider.js';

/**
 * Mapbox Matrix API v1 (§18, §19).
 *
 * The second and last file in the codebase that knows Mapbox exists. Discovery
 * depends on [RouteCostProvider] and never on this class.
 *
 * **Why a matrix rather than N route calls.** Detour evaluation asks the same question
 * for every candidate: what does `origin → place → destination` cost? Answering it
 * with Directions means one billed request per candidate — twenty candidates, twenty
 * requests, twenty round trips. The Matrix API answers all of them in one request, so
 * the provider cost of a discovery becomes a constant instead of a multiple of how
 * many Places happen to sit near the route (§21, §98).
 *
 * Verified against the current Mapbox documentation at implementation time: the
 * `driving` profile accepts **25 coordinates** per request and allows **60 requests
 * per minute**, and `annotations` may request duration and distance together without
 * reducing the coordinate limit. Origin and destination occupy two of the twenty-five,
 * which is where [maxViaPointsPerCall] comes from.
 *
 * **What is deliberately not used.** The Optimization API solves a travelling-salesman
 * ordering; discovery does not order anything and does not need it (§19). Nor is the
 * `driving-traffic` profile used: live traffic would make the same request return
 * different rankings minute to minute, and V1 promises a deterministic result (§38).
 */

/** Mapbox's own shape. Local to this file by design. */
interface MapboxMatrixResponse {
  code?: string;
  message?: string;
  durations?: (number | null)[][];
  distances?: (number | null)[][];
}

const PROVIDER_NAME = 'mapbox-matrix-v1';

/** 25 coordinates per driving request, less the origin and the destination. */
const MAPBOX_MATRIX_COORDINATE_LIMIT = 25;

@Injectable()
export class MapboxRouteCostProvider implements RouteCostProvider {
  readonly maxViaPointsPerCall = MAPBOX_MATRIX_COORDINATE_LIMIT - 2;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MapboxRouteCostProvider.name);
  }

  async viaCosts(request: ViaCostRequest): Promise<ViaCostResult> {
    if (request.via.length === 0) {
      throw new RoutingProviderUnavailableError(new Error('No via points to evaluate'));
    }
    if (request.via.length > this.maxViaPointsPerCall) {
      /* A caller error rather than a provider one: batching is the application's job
         and it has `maxViaPointsPerCall` to do it with. */
      throw new RoutingProviderUnavailableError(
        new Error(`A matrix call accepts at most ${String(this.maxViaPointsPerCall)} via points`),
      );
    }

    const url = this.buildUrl(request);
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.routing.timeoutMs),
      });
    } catch (error) {
      throw this.toTransportError(error);
    }

    const latencyMs = Math.round(performance.now() - startedAt);
    if (!response.ok) throw this.toHttpError(response.status, latencyMs);

    let payload: MapboxMatrixResponse;
    try {
      payload = (await response.json()) as MapboxMatrixResponse;
    } catch (error) {
      throw new RoutingProviderUnavailableError(error);
    }

    return this.normalise(payload, request.via.length, latencyMs);
  }

  /**
   * Builds the matrix request.
   *
   * Coordinate order is fixed and load-bearing: index 0 is the origin, index 1 the
   * destination, and the via-points follow in the caller's order. The full square
   * matrix is requested rather than `sources`/`destinations` subsets because the
   * pipeline needs both `origin → via` and `via → destination` from the same call,
   * and one square is cheaper than two rectangles.
   *
   * The URL carries the access token, which is why it is never logged (§57, §82).
   */
  private buildUrl(request: ViaCostRequest): string {
    const points: RoutePoint[] = [request.origin, request.destination, ...request.via];
    const coordinates = points.map((p) => `${String(p.longitude)},${String(p.latitude)}`).join(';');

    const url = new URL(
      `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${encodeURIComponent(coordinates)}`,
    );
    url.searchParams.set('annotations', 'duration,distance');
    url.searchParams.set('access_token', this.config.routing.accessToken);

    return url.toString();
  }

  private toTransportError(error: unknown): Error {
    const isTimeout =
      error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');

    this.logger.warn(
      { event: 'discovery.provider.transport_failed', provider: PROVIDER_NAME, timeout: isTimeout },
      'Route cost provider transport failure',
    );

    return isTimeout
      ? new RoutingProviderTimeoutError(error)
      : new RoutingProviderUnavailableError(error);
  }

  private toHttpError(status: number, latencyMs: number): Error {
    this.logger.warn(
      { event: 'discovery.provider.http_error', provider: PROVIDER_NAME, status, latencyMs },
      'Route cost provider returned an error status',
    );

    if (status === 429) return new RoutingProviderRateLimitedError();
    if (status === 401 || status === 403) {
      this.logger.error(
        { event: 'discovery.provider.unauthorised', provider: PROVIDER_NAME },
        'Route cost provider rejected our credentials',
      );
      return new RoutingProviderUnavailableError();
    }

    return new RoutingProviderUnavailableError();
  }

  /**
   * Turns a matrix into per-candidate journey costs.
   *
   * `durations[i][j]` is the cost of travelling from coordinate `i` to coordinate `j`.
   * With the fixed layout above, the candidate at via-index `k` sits at coordinate
   * `k + 2`, so its diverted journey is `durations[0][k+2] + durations[k+2][1]`.
   *
   * A `null` anywhere in that pair means the provider could not connect the point by
   * road. That is a fact about the place, not a failure of the request, so the entry
   * becomes `null` and the pipeline drops that candidate (§50).
   */
  private normalise(
    payload: MapboxMatrixResponse,
    viaCount: number,
    latencyMs: number,
  ): ViaCostResult {
    if (payload.code !== undefined && payload.code !== 'Ok') {
      throw new RoutingProviderUnavailableError();
    }

    const durations = payload.durations;
    const distances = payload.distances;
    const expected = viaCount + 2;

    if (!isSquareMatrix(durations, expected) || !isSquareMatrix(distances, expected)) {
      throw new RoutingProviderUnavailableError(
        new Error('Provider returned a matrix of unexpected shape'),
      );
    }

    const baselineDuration = durations[0]?.[1];
    const baselineDistance = distances[0]?.[1];
    if (
      typeof baselineDuration !== 'number' ||
      typeof baselineDistance !== 'number' ||
      !Number.isFinite(baselineDuration) ||
      !Number.isFinite(baselineDistance)
    ) {
      /* Without a baseline there is nothing to measure a detour against, so the whole
         batch is unusable — unlike a single unreachable candidate. */
      throw new RoutingProviderUnavailableError(
        new Error('Provider could not route between the endpoints'),
      );
    }

    const via: (RouteMetrics | null)[] = [];
    for (let k = 0; k < viaCount; k += 1) {
      const index = k + 2;
      const outboundDuration = durations[0]?.[index];
      const inboundDuration = durations[index]?.[1];
      const outboundDistance = distances[0]?.[index];
      const inboundDistance = distances[index]?.[1];

      if (
        typeof outboundDuration !== 'number' ||
        typeof inboundDuration !== 'number' ||
        typeof outboundDistance !== 'number' ||
        typeof inboundDistance !== 'number' ||
        !Number.isFinite(outboundDuration) ||
        !Number.isFinite(inboundDuration) ||
        !Number.isFinite(outboundDistance) ||
        !Number.isFinite(inboundDistance)
      ) {
        via.push(null);
        continue;
      }

      via.push({
        distanceMeters: outboundDistance + inboundDistance,
        durationSeconds: outboundDuration + inboundDuration,
      });
    }

    return {
      baseline: { distanceMeters: baselineDistance, durationSeconds: baselineDuration },
      via,
      provider: { name: PROVIDER_NAME, latencyMs },
    };
  }
}

function isSquareMatrix(value: unknown, size: number): value is (number | null)[][] {
  return (
    Array.isArray(value) &&
    value.length === size &&
    value.every((row) => Array.isArray(row) && row.length === size)
  );
}
