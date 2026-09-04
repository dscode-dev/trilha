import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import { loadAppConfig } from '../../../infrastructure/config/app-config.js';
import { MapboxRoutingProvider } from './mapbox-routing.provider.js';
import { parseLineString } from '../domain/route.js';
import { RoutingProfile } from '../domain/routing-provider.js';
import {
  InvalidRouteGeometryError,
  RouteNotFoundError,
  RoutingProviderRateLimitedError,
  RoutingProviderTimeoutError,
  RoutingProviderUnavailableError,
} from '../domain/routing-errors.js';
import {
  directionsMissingMetrics,
  directionsNoLegs,
  directionsNoRoute,
  directionsOutOfBounds,
  directionsSinglePoint,
  directionsSuccess,
  directionsWrongGeometryType,
} from '../../../../test/fixtures/mapbox-directions.js';

/**
 * The Mapbox adapter, with the network stubbed (§51).
 *
 * Every upstream outcome is exercised: success, no route, malformed geometry, bad
 * metrics, throttling, server error, timeout and dead network. What is asserted is
 * that each becomes a *normalised* Trilha error — a client must never receive a
 * provider's own shape, and the access token must never appear in a log or a message.
 */
describe('MapboxRoutingProvider', () => {
  const env = {
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/trilha',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'PPMKe3xE1YHUiJgpEsYYPMOMy6R6zUKAPuOwUv3jS7c',
    IP_HASH_KEY: 'Yh0bJ4gGLxOaAr9OMPvBGEBWWJhBQXoflb0LBIsBnh4',
    MAPBOX_ROUTING_ACCESS_TOKEN: 'pk.super-secret-routing-token-value',
    ROUTING_PROVIDER_TIMEOUT_MS: '5000',
  };

  const request = {
    origin: { latitude: -8.0631, longitude: -34.8711 },
    destination: { latitude: -7.115, longitude: -34.8631 },
    profile: RoutingProfile.DRIVING,
  };

  let logged: unknown[];
  let provider: MapboxRoutingProvider;

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    logged = [];
    /* Captures every log line so the secret-handling tests can inspect them. */
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

    provider = new MapboxRoutingProvider(loadAppConfig(env), logger);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('success', () => {
    it('normalises a route into Trilha vocabulary', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(directionsSuccess)));

      const result = await provider.calculateRoute(request);

      expect(result.metrics.distanceMeters).toBeCloseTo(105_060.4, 1);
      expect(result.metrics.durationSeconds).toBeCloseTo(6_480.2, 1);
      expect(result.geometry.type).toBe('LineString');
      expect(result.geometry.coordinates).toHaveLength(6);
      expect(result.legs).toHaveLength(1);
      expect(result.legs[0]?.summary).toBe('BR-101');
    });

    it('reports provider attribution without leaking credentials', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(directionsSuccess)));

      const result = await provider.calculateRoute(request);

      expect(result.provider.name).toBe('mapbox-directions-v5');
      expect(result.provider.latencyMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(result)).not.toContain('super-secret-routing-token');
    });

    it('requests GeoJSON at full overview, without alternatives', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(directionsSuccess));
      vi.stubGlobal('fetch', fetchMock);

      await provider.calculateRoute(request);

      const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
      expect(url.searchParams.get('geometries')).toBe('geojson');
      /* A simplified overview would misplace the corridor at exactly the bends
         where it matters (§62). */
      expect(url.searchParams.get('overview')).toBe('full');
      expect(url.searchParams.get('alternatives')).toBe('false');
    });

    it('sends coordinates as longitude,latitude — the provider’s order', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(directionsSuccess));
      vi.stubGlobal('fetch', fetchMock);

      await provider.calculateRoute(request);

      /* Reversing these is the classic geospatial bug: it would route from the wrong
         hemisphere without any error. */
      expect(fetchMock.mock.calls[0]?.[0] as string).toContain(
        encodeURIComponent('-34.8711,-8.0631;-34.8631,-7.115'),
      );
    });

    it('synthesises a leg when the provider omits the array', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(directionsNoLegs)));

      const result = await provider.calculateRoute(request);

      expect(result.legs).toHaveLength(1);
      expect(result.legs[0]?.distanceMeters).toBe(500);
      expect(result.legs[0]?.summary).toBeNull();
    });

    it('applies the configured deadline', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(directionsSuccess));
      vi.stubGlobal('fetch', fetchMock);

      await provider.calculateRoute(request);

      const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal };
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('upstream failures, normalised (§22)', () => {
    it('maps a NoRoute code to ROUTE_NOT_FOUND', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(directionsNoRoute)));

      await expect(provider.calculateRoute(request)).rejects.toThrow(RouteNotFoundError);
    });

    it('maps an empty routes array to ROUTE_NOT_FOUND', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: 'Ok', routes: [] })));

      await expect(provider.calculateRoute(request)).rejects.toThrow(RouteNotFoundError);
    });

    it('maps 422 to ROUTE_NOT_FOUND', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 422)));

      await expect(provider.calculateRoute(request)).rejects.toThrow(RouteNotFoundError);
    });

    it('maps 429 to a provider rate-limit error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 429)));

      await expect(provider.calculateRoute(request)).rejects.toThrow(
        RoutingProviderRateLimitedError,
      );
    });

    it.each([500, 502, 503])('maps upstream %i to an unavailable error', async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, status)));

      await expect(provider.calculateRoute(request)).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('treats our own bad credentials as an outage, not a client error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));

      /* A caller cannot fix Trilha's token, so telling them "unauthorized" would be
         both useless and misleading. */
      await expect(provider.calculateRoute(request)).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('maps a timeout to a timeout error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError')),
      );

      await expect(provider.calculateRoute(request)).rejects.toThrow(RoutingProviderTimeoutError);
    });

    it('maps a dead network to an unavailable error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      await expect(provider.calculateRoute(request)).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('maps an unparseable body to an unavailable error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('<html>gateway error</html>', { status: 200 })),
      );

      await expect(provider.calculateRoute(request)).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });
  });

  describe('malformed provider results (§63)', () => {
    it.each([
      ['a non-LineString geometry', directionsWrongGeometryType],
      ['a single-position line', directionsSinglePoint],
      ['a position outside coordinate bounds', directionsOutOfBounds],
      ['missing metrics', directionsMissingMetrics],
    ])('rejects %s', async (_name, payload) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));

      await expect(provider.calculateRoute(request)).rejects.toThrow(InvalidRouteGeometryError);
    });
  });

  describe('secret handling (§57)', () => {
    it('never writes the access token to a log', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 500)));

      await expect(provider.calculateRoute(request)).rejects.toThrow();

      /* The request URL carries the token, so logging it would leak the credential
         on every upstream error. */
      const serialised = JSON.stringify(logged);
      expect(serialised).not.toContain('super-secret-routing-token');
      expect(serialised).not.toContain('access_token');
      expect(logged.length).toBeGreaterThan(0);
    });

    it('never puts the token in a client-facing error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));

      try {
        await provider.calculateRoute(request);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain('super-secret-routing-token');
        expect((error as Error).message).not.toContain('mapbox.com');
      }
    });
  });
});

describe('parseLineString', () => {
  it('accepts a valid line', () => {
    const geometry = parseLineString({
      type: 'LineString',
      coordinates: [
        [-34.87, -8.06],
        [-34.86, -7.11],
      ],
    });

    expect(geometry.coordinates).toHaveLength(2);
  });

  it.each([
    ['null', null],
    ['a string', 'LINESTRING(0 0, 1 1)'],
    ['a wrong type', { type: 'Polygon', coordinates: [] }],
    ['non-array coordinates', { type: 'LineString', coordinates: 'nope' }],
    ['too few positions', { type: 'LineString', coordinates: [[0, 0]] }],
    ['a position that is not a pair', { type: 'LineString', coordinates: [[0], [1]] }],
    [
      'a non-numeric position',
      {
        type: 'LineString',
        coordinates: [
          ['a', 'b'],
          [0, 0],
        ],
      },
    ],
    [
      'NaN in a position',
      {
        type: 'LineString',
        coordinates: [
          [Number.NaN, 0],
          [0, 0],
        ],
      },
    ],
    [
      'latitude out of range',
      {
        type: 'LineString',
        coordinates: [
          [0, 91],
          [0, 0],
        ],
      },
    ],
    [
      'longitude out of range',
      {
        type: 'LineString',
        coordinates: [
          [181, 0],
          [0, 0],
        ],
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => {
      parseLineString(value);
    }).toThrow(InvalidRouteGeometryError);
  });
});
