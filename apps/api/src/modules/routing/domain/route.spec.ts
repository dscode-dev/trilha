import { describe, expect, it } from 'vitest';
import { boundsOf, greatCircleMeters, type RouteGeometry } from './route.js';
import {
  MAXIMUM_SEPARATION_METERS,
  MINIMUM_SEPARATION_METERS,
  assertRoutableEndpoints,
  calculateRouteSchema,
} from './route-request.js';
import { DegenerateRouteError, RouteTooLongError } from './routing-errors.js';

const RECIFE = { latitude: -8.0631, longitude: -34.8711 };
const JOAO_PESSOA = { latitude: -7.115, longitude: -34.8631 };

const line = (coordinates: [number, number][]): RouteGeometry => ({
  type: 'LineString',
  coordinates,
});

describe('boundsOf', () => {
  it('derives the extent from the geometry', () => {
    const bounds = boundsOf(
      line([
        [-34.8711, -8.0631],
        [-34.85, -7.6],
        [-34.8631, -7.115],
      ]),
    );

    expect(bounds.north).toBeCloseTo(-7.115, 4);
    expect(bounds.south).toBeCloseTo(-8.0631, 4);
    expect(bounds.east).toBeCloseTo(-34.85, 4);
    expect(bounds.west).toBeCloseTo(-34.8711, 4);
  });

  it('handles a two-point line', () => {
    const bounds = boundsOf(
      line([
        [-34.8711, -8.0631],
        [-34.8631, -7.115],
      ]),
    );

    expect(bounds.north).toBeGreaterThan(bounds.south);
    expect(bounds.east).toBeGreaterThan(bounds.west);
  });

  it('produces a degenerate box for a line that does not move', () => {
    const bounds = boundsOf(
      line([
        [-34.8711, -8.0631],
        [-34.8711, -8.0631],
      ]),
    );

    expect(bounds.north).toBe(bounds.south);
    expect(bounds.east).toBe(bounds.west);
  });

  it('covers every vertex, not just the endpoints', () => {
    /* A route that bulges west of both endpoints — bounds taken from origin and
       destination alone would clip it. */
    const bounds = boundsOf(
      line([
        [-34.87, -8.06],
        [-35.5, -7.6],
        [-34.86, -7.11],
      ]),
    );

    expect(bounds.west).toBeCloseTo(-35.5, 4);
  });

  it('refuses to compute bounds of an empty geometry', () => {
    expect(() => {
      boundsOf(line([]));
    }).toThrow(/empty geometry/);
  });
});

describe('greatCircleMeters', () => {
  it('measures a known separation', () => {
    /* Recife to João Pessoa is ~105 km by road and ~106 km straight line. */
    const metres = greatCircleMeters(RECIFE, JOAO_PESSOA);

    expect(metres).toBeGreaterThan(100_000);
    expect(metres).toBeLessThan(115_000);
  });

  it('is zero for identical points', () => {
    expect(greatCircleMeters(RECIFE, RECIFE)).toBeCloseTo(0, 5);
  });

  it('is symmetric', () => {
    expect(greatCircleMeters(RECIFE, JOAO_PESSOA)).toBeCloseTo(
      greatCircleMeters(JOAO_PESSOA, RECIFE),
      6,
    );
  });

  it('handles antipodal points without returning NaN', () => {
    const metres = greatCircleMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 180 },
    );

    expect(Number.isFinite(metres)).toBe(true);
    expect(metres).toBeGreaterThan(19_000_000);
  });
});

describe('assertRoutableEndpoints', () => {
  it('accepts a real journey', () => {
    expect(() => {
      assertRoutableEndpoints(RECIFE, JOAO_PESSOA);
    }).not.toThrow();
  });

  it('rejects identical points before any provider call (§55)', () => {
    expect(() => {
      assertRoutableEndpoints(RECIFE, RECIFE);
    }).toThrow(DegenerateRouteError);
  });

  it('rejects points inside the minimum separation', () => {
    /* ~11 m north — inside GPS noise, so not a journey. */
    const almostThere = { latitude: RECIFE.latitude + 0.0001, longitude: RECIFE.longitude };

    expect(greatCircleMeters(RECIFE, almostThere)).toBeLessThan(MINIMUM_SEPARATION_METERS);
    expect(() => {
      assertRoutableEndpoints(RECIFE, almostThere);
    }).toThrow(DegenerateRouteError);
  });

  it('accepts a short but genuine hop', () => {
    /* ~110 m — across a couple of blocks. */
    const nearby = { latitude: RECIFE.latitude + 0.001, longitude: RECIFE.longitude };

    expect(() => {
      assertRoutableEndpoints(RECIFE, nearby);
    }).not.toThrow();
  });

  it('rejects an implausible separation (§56)', () => {
    const antipode = { latitude: 8.0631, longitude: 145.1289 };

    expect(greatCircleMeters(RECIFE, antipode)).toBeGreaterThan(MAXIMUM_SEPARATION_METERS);
    expect(() => {
      assertRoutableEndpoints(RECIFE, antipode);
    }).toThrow(RouteTooLongError);
  });

  it('names the threshold it enforced, so a client can explain itself', () => {
    try {
      assertRoutableEndpoints(RECIFE, RECIFE);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as DegenerateRouteError).details).toEqual({
        minimumSeparationMeters: MINIMUM_SEPARATION_METERS,
      });
    }
  });
});

describe('calculateRouteSchema', () => {
  const valid = { origin: RECIFE, destination: JOAO_PESSOA };

  it('accepts a well-formed request', () => {
    expect(calculateRouteSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts optional placeIds', () => {
    const parsed = calculateRouteSchema.safeParse({
      origin: { ...RECIFE, placeId: '01a06cc8-9b3a-7ba0-879e-f01610559f9c' },
      destination: JOAO_PESSOA,
    });

    expect(parsed.success).toBe(true);
  });

  it('does not require a placeId (§7)', () => {
    expect(calculateRouteSchema.safeParse(valid).success).toBe(true);
  });

  /* The coordinate rules are the Places rules, imported rather than restated (§8). */
  it.each([
    ['latitude out of range', { origin: { latitude: 91, longitude: 0 } }],
    ['longitude out of range', { origin: { latitude: 0, longitude: 181 } }],
    ['NaN latitude', { origin: { latitude: Number.NaN, longitude: 0 } }],
    ['Infinity longitude', { origin: { latitude: 0, longitude: Number.POSITIVE_INFINITY } }],
    ['empty-string latitude', { origin: { latitude: '', longitude: 0 } }],
    ['null longitude', { origin: { latitude: 0, longitude: null } }],
  ])('rejects an origin with %s', (_name, override) => {
    expect(calculateRouteSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it('rejects a missing origin', () => {
    expect(calculateRouteSchema.safeParse({ destination: JOAO_PESSOA }).success).toBe(false);
  });

  it('rejects a missing destination', () => {
    expect(calculateRouteSchema.safeParse({ origin: RECIFE }).success).toBe(false);
  });

  it('rejects a malformed placeId', () => {
    expect(
      calculateRouteSchema.safeParse({
        origin: { ...RECIFE, placeId: 'not-a-uuid' },
        destination: JOAO_PESSOA,
      }).success,
    ).toBe(false);
  });
});
