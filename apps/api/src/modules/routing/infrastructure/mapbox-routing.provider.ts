import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../../../infrastructure/config/app-config.js';
import { parseLineString, type RouteLeg } from '../domain/route.js';
import {
  InvalidRouteGeometryError,
  RouteNotFoundError,
  RoutingProviderRateLimitedError,
  RoutingProviderTimeoutError,
  RoutingProviderUnavailableError,
} from '../domain/routing-errors.js';
import type { RoutingProvider, RoutingRequest, RoutingResult } from '../domain/routing-provider.js';

/**
 * Mapbox Directions API v5 (§10).
 *
 * The only file in the codebase that knows Mapbox computes routes. Everything above
 * it depends on [RoutingProvider], and nothing Mapbox-shaped crosses that line: the
 * response is normalised here and the raw payload is discarded (§64).
 *
 * Uses Node's built-in `fetch` and `AbortSignal.timeout`. An HTTP client dependency
 * would buy nothing here — one request, one timeout, no interceptors.
 */

/** Mapbox's own shape. Local to this file by design. */
interface MapboxDirectionsResponse {
  code?: string;
  message?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: { type?: string; coordinates?: unknown };
    legs?: { distance?: number; duration?: number; summary?: string }[];
  }[];
}

const PROVIDER_NAME = 'mapbox-directions-v5';

@Injectable()
export class MapboxRoutingProvider implements RoutingProvider {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MapboxRoutingProvider.name);
  }

  async calculateRoute(request: RoutingRequest): Promise<RoutingResult> {
    const url = this.buildUrl(request);
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        /* An unbounded upstream call would hold a request open indefinitely (§23). */
        signal: AbortSignal.timeout(this.config.routing.timeoutMs),
      });
    } catch (error) {
      throw this.toTransportError(error);
    }

    const latencyMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      throw this.toHttpError(response.status, latencyMs);
    }

    let payload: MapboxDirectionsResponse;
    try {
      payload = (await response.json()) as MapboxDirectionsResponse;
    } catch (error) {
      throw new RoutingProviderUnavailableError(error);
    }

    return this.normalise(payload, latencyMs);
  }

  /**
   * Builds the Directions request.
   *
   * `geometries=geojson` avoids an encoded-polyline decode step and gives PostGIS
   * something it can read directly. `overview=full` keeps the geometry at road
   * fidelity — a simplified overview would make the corridor wrong at exactly the
   * bends where it matters.
   *
   * The URL carries the access token, which is why it is never logged (§57).
   */
  private buildUrl(request: RoutingRequest): string {
    const { origin, destination } = request;
    /* Mapbox takes longitude,latitude — the opposite of how people say it. */
    const coordinates = `${String(origin.longitude)},${String(origin.latitude)};${String(destination.longitude)},${String(destination.latitude)}`;

    const url = new URL(
      `https://api.mapbox.com/directions/v5/mapbox/driving/${encodeURIComponent(coordinates)}`,
    );
    url.searchParams.set('geometries', 'geojson');
    url.searchParams.set('overview', 'full');
    url.searchParams.set('alternatives', 'false');
    url.searchParams.set('steps', 'false');
    url.searchParams.set('access_token', this.config.routing.accessToken);

    return url.toString();
  }

  /** Distinguishes a deadline from a dead network; both are opaque from `fetch`. */
  private toTransportError(error: unknown): Error {
    const isTimeout =
      error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');

    /* The URL is deliberately absent from this log line: it contains the token. */
    this.logger.warn(
      { event: 'routing.provider.transport_failed', provider: PROVIDER_NAME, timeout: isTimeout },
      'Routing provider transport failure',
    );

    return isTimeout
      ? new RoutingProviderTimeoutError(error)
      : new RoutingProviderUnavailableError(error);
  }

  private toHttpError(status: number, latencyMs: number): Error {
    this.logger.warn(
      { event: 'routing.provider.http_error', provider: PROVIDER_NAME, status, latencyMs },
      'Routing provider returned an error status',
    );

    if (status === 429) return new RoutingProviderRateLimitedError();
    if (status === 401 || status === 403) {
      /* Our credential is wrong, not the caller's request — surface it as an outage
         so no client is told to fix something it does not control. */
      this.logger.error(
        { event: 'routing.provider.unauthorised', provider: PROVIDER_NAME },
        'Routing provider rejected our credentials',
      );
      return new RoutingProviderUnavailableError();
    }
    if (status === 422) return new RouteNotFoundError();

    return new RoutingProviderUnavailableError();
  }

  /**
   * Turns a Directions response into Trilha's vocabulary.
   *
   * Nothing upstream is trusted: `code`, the route array, the geometry type and every
   * coordinate are checked before use. A provider that changes shape should fail
   * here, loudly, rather than produce a route that renders somewhere unexpected (§63).
   */
  private normalise(payload: MapboxDirectionsResponse, latencyMs: number): RoutingResult {
    if (payload.code === 'NoRoute' || payload.code === 'NoSegment') {
      throw new RouteNotFoundError();
    }
    if (payload.code !== undefined && payload.code !== 'Ok') {
      throw new RoutingProviderUnavailableError();
    }

    const route = payload.routes?.[0];
    if (route === undefined) throw new RouteNotFoundError();

    const geometry = parseLineString(route.geometry);
    const distanceMeters = finiteNumber(route.distance, 'distance');
    const durationSeconds = finiteNumber(route.duration, 'duration');

    const legs: RouteLeg[] = (route.legs ?? []).map((leg) => ({
      distanceMeters: finiteNumber(leg.distance, 'leg distance'),
      durationSeconds: finiteNumber(leg.duration, 'leg duration'),
      summary: typeof leg.summary === 'string' && leg.summary.length > 0 ? leg.summary : null,
    }));

    return {
      geometry,
      metrics: { distanceMeters, durationSeconds },
      /* A route always has at least one leg; synthesise it if the provider omitted
         the array so downstream never has to handle an empty case. */
      legs: legs.length > 0 ? legs : [{ distanceMeters, durationSeconds, summary: null }],
      provider: { name: PROVIDER_NAME, latencyMs },
    };
  }
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InvalidRouteGeometryError(`Provider returned a non-numeric ${field}`);
  }
  return value;
}
