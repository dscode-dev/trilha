import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import { loadAppConfig } from '../../../infrastructure/config/app-config.js';
import {
  RoutingProviderRateLimitedError,
  RoutingProviderTimeoutError,
  RoutingProviderUnavailableError,
} from '../../routing/domain/routing-errors.js';
import { MapboxRouteCostProvider } from './mapbox-route-cost.provider.js';
import {
  matrixDurationsOnly,
  matrixNoBaseline,
  matrixProfileNotFound,
  matrixTwoCandidates,
  matrixUnreachableCandidate,
  matrixWrongShape,
} from '../../../../test/fixtures/mapbox-matrix.js';

/**
 * The Matrix adapter, with the network stubbed (§71).
 *
 * Every upstream outcome is exercised, and the token is asserted absent from every log
 * line the adapter writes — the URL carries it in a query parameter, so logging the
 * failed request is the one reflex that would leak a spendable credential (§82).
 */
describe('MapboxRouteCostProvider', () => {
  const env = {
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/trilha',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'PPMKe3xE1YHUiJgpEsYYPMOMy6R6zUKAPuOwUv3jS7c',
    IP_HASH_KEY: 'Yh0bJ4gGLxOaAr9OMPvBGEBWWJhBQXoflb0LBIsBnh4',
    MAPBOX_ROUTING_ACCESS_TOKEN: 'pk.super-secret-routing-token-value',
    ROUTING_PROVIDER_TIMEOUT_MS: '5000',
  };

  const origin = { latitude: -8.0631, longitude: -34.8711 };
  const destination = { latitude: -7.115, longitude: -34.8631 };
  const via = [
    { latitude: -7.85, longitude: -34.85 },
    { latitude: -7.6, longitude: -34.6 },
  ];
  /** A single via-point, for the fixtures shaped as a 3×3 matrix. */
  const oneVia = [{ latitude: -7.85, longitude: -34.85 }];

  let logged: unknown[];
  let provider: MapboxRouteCostProvider;

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    logged = [];
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

    provider = new MapboxRouteCostProvider(loadAppConfig(env), logger);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('batch size', () => {
    it('reports the provider ceiling less the two endpoints', () => {
      /* 25 coordinates per driving request, minus origin and destination. Verified
         against the Mapbox documentation at implementation time. */
      expect(provider.maxViaPointsPerCall).toBe(23);
    });

    it('refuses a batch larger than one call can carry', async () => {
      const tooMany = Array.from({ length: 24 }, (_, i) => ({
        latitude: -7.9 + i * 0.01,
        longitude: -34.8,
      }));

      await expect(provider.viaCosts({ origin, destination, via: tooMany })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('refuses an empty batch rather than spending a call on nothing', async () => {
      await expect(provider.viaCosts({ origin, destination, via: [] })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });
  });

  describe('request shape', () => {
    it('places origin first, destination second, via-points after', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(matrixTwoCandidates));
      vi.stubGlobal('fetch', fetchMock);

      await provider.viaCosts({ origin, destination, via });

      const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
      const coordinates = decodeURIComponent(url.pathname.split('/').pop() ?? '');

      expect(coordinates).toBe('-34.8711,-8.0631;-34.8631,-7.115;-34.85,-7.85;-34.6,-7.6');
    });

    it('asks for durations and distances together', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(matrixTwoCandidates));
      vi.stubGlobal('fetch', fetchMock);

      await provider.viaCosts({ origin, destination, via });

      const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
      expect(url.searchParams.get('annotations')).toBe('duration,distance');
    });

    it('uses the driving profile, not driving-traffic', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(matrixTwoCandidates));
      vi.stubGlobal('fetch', fetchMock);

      await provider.viaCosts({ origin, destination, via });

      const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
      /* Live traffic would make the same request rank differently minute to minute,
         and V1 promises a deterministic result (§38). */
      expect(url.pathname).toContain('/mapbox/driving/');
      expect(url.pathname).not.toContain('driving-traffic');
    });

    it('bounds the call with the configured timeout', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(matrixTwoCandidates));
      vi.stubGlobal('fetch', fetchMock);

      await provider.viaCosts({ origin, destination, via });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('normalisation', () => {
    it('returns the provider’s own baseline, for like-for-like comparison', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(matrixTwoCandidates)));

      const result = await provider.viaCosts({ origin, destination, via });

      expect(result.baseline).toEqual({ distanceMeters: 105_060, durationSeconds: 6_480 });
    });

    it('sums the outbound and inbound legs for each via-point', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(matrixTwoCandidates)));

      const result = await provider.viaCosts({ origin, destination, via });

      /* via[0]: 2,900 out + 4,000 back = 6,900 — a 420 s detour on a 6,480 s route. */
      expect(result.via[0]).toEqual({ distanceMeters: 108_460, durationSeconds: 6_900 });
      /* via[1]: 4,100 + 4,780 = 8,880 — a 2,400 s detour. */
      expect(result.via[1]).toEqual({ distanceMeters: 110_060, durationSeconds: 8_880 });
    });

    it('keeps results index-aligned with the request', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(matrixTwoCandidates)));

      const result = await provider.viaCosts({ origin, destination, via });

      expect(result.via).toHaveLength(via.length);
    });

    it('attributes the call without naming a credential', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(matrixTwoCandidates)));

      const result = await provider.viaCosts({ origin, destination, via });

      expect(result.provider.name).toBe('mapbox-matrix-v1');
      expect(result.provider.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('reports an unreachable via-point as null rather than failing the batch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(matrixUnreachableCandidate)));

      const result = await provider.viaCosts({ origin, destination, via });

      /* One place with no road connection is a fact about that place. The rest of the
         batch is still a perfectly good answer (§50). */
      expect(result.via[0]).not.toBeNull();
      expect(result.via[1]).toBeNull();
    });

    it('fails the whole batch when the endpoints cannot be connected', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(matrixNoBaseline)));

      /* Without a baseline there is nothing to measure a detour against, so every
         number in the batch would be meaningless. */
      await expect(provider.viaCosts({ origin, destination, via: oneVia })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('rejects a matrix whose dimensions do not match the request', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(matrixWrongShape)));

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('rejects a response missing the distance annotation', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(matrixDurationsOnly)));

      await expect(provider.viaCosts({ origin, destination, via: oneVia })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('rejects a non-Ok provider code', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(matrixProfileNotFound)));

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('rejects a body that is not JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 200 })),
      );

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });
  });

  describe('error mapping', () => {
    it('maps 429 to rate limited', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 429)));

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow(
        RoutingProviderRateLimitedError,
      );
    });

    it('maps 401 to unavailable, never to a caller-facing auth failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));

      /* Our credential is wrong. A caller told to re-authenticate would be told to fix
         something it does not control. */
      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('maps 403 to unavailable as well', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 403)));

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('maps a 5xx to unavailable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 502)));

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });

    it('maps a deadline to a timeout', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError')),
      );

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow(
        RoutingProviderTimeoutError,
      );
    });

    it('maps a dead network to unavailable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow(
        RoutingProviderUnavailableError,
      );
    });
  });

  describe('credential handling (§82)', () => {
    it('never logs the token on an HTTP error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 500)));

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow();

      expect(JSON.stringify(logged)).not.toContain('super-secret-routing-token-value');
    });

    it('never logs the token on a transport failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow();

      expect(JSON.stringify(logged)).not.toContain('super-secret-routing-token-value');
    });

    it('never logs the request URL, which carries the token', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));

      await expect(provider.viaCosts({ origin, destination, via })).rejects.toThrow();

      expect(JSON.stringify(logged)).not.toContain('api.mapbox.com');
      expect(JSON.stringify(logged)).not.toContain('access_token');
    });

    it('keeps the token out of the error surfaced to a caller', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 403)));

      const error = await provider.viaCosts({ origin, destination, via }).catch((e: unknown) => e);

      expect(JSON.stringify(error instanceof Error ? error.message : error)).not.toContain(
        'super-secret-routing-token-value',
      );
    });
  });
});
