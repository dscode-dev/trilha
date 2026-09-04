import { describe, expect, it } from 'vitest';
import {
  BBOX_MAX_SPAN_DEGREES,
  RADIUS_MAX_METRES,
  RADIUS_MIN_METRES,
  boundingBoxSchema,
  latitudeSchema,
  longitudeSchema,
  radiusMetresSchema,
} from './coordinates.js';

/**
 * Coordinate validation (§8).
 *
 * This is the only guard against out-of-range input: PostGIS `geography` *coerces*
 * rather than rejects, so a latitude of 91 that reaches SQL is stored as 89 with no
 * error. These tests are what keep that from happening.
 */
describe('latitudeSchema', () => {
  it.each([0, -90, 90, -8.0631, 45.5])('accepts %p', (value) => {
    expect(latitudeSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['just past the north pole', 90.000001],
    ['just past the south pole', -90.000001],
    ['far out of range', 91],
    ['very far out of range', 1000],
  ])('rejects %s', (_name, value) => {
    expect(latitudeSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['the string "NaN"', 'NaN'],
    ['the string "Infinity"', 'Infinity'],
    ['a non-numeric string', 'abc'],
  ])('rejects %s', (_name, value) => {
    expect(latitudeSchema.safeParse(value).success).toBe(false);
  });

  /**
   * The coercion trap: `Number('')` and `Number(null)` are both 0, so a missing
   * coordinate would otherwise become a valid point at 0°, 0° — in the Gulf of
   * Guinea, with nothing to indicate anything went wrong.
   */
  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s rather than reading it as zero', (_name, value) => {
    expect(latitudeSchema.safeParse(value).success).toBe(false);
  });

  it('accepts a numeric string, since query parameters arrive as text', () => {
    const parsed = latitudeSchema.safeParse('-8.0631');
    expect(parsed.success && parsed.data).toBe(-8.0631);
  });

  it('accepts a genuine zero', () => {
    expect(latitudeSchema.safeParse(0).success).toBe(true);
    expect(latitudeSchema.safeParse('0').success).toBe(true);
  });
});

describe('longitudeSchema', () => {
  it.each([0, -180, 180, -34.8711])('accepts %p', (value) => {
    expect(longitudeSchema.safeParse(value).success).toBe(true);
  });

  it.each([180.000001, -180.000001, 360])('rejects %p', (value) => {
    expect(longitudeSchema.safeParse(value).success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(longitudeSchema.safeParse('').success).toBe(false);
  });
});

describe('radiusMetresSchema', () => {
  it('defaults when omitted', () => {
    const parsed = radiusMetresSchema.safeParse(undefined);
    expect(parsed.success && parsed.data).toBe(2_000);
  });

  it.each([RADIUS_MIN_METRES, 1_000, RADIUS_MAX_METRES])('accepts %p metres', (value) => {
    expect(radiusMetresSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['below the minimum', RADIUS_MIN_METRES - 1],
    ['above the maximum', RADIUS_MAX_METRES + 1],
    ['negative', -100],
    ['zero', 0],
    ['fractional', 100.5],
  ])('rejects a radius %s', (_name, value) => {
    expect(radiusMetresSchema.safeParse(value).success).toBe(false);
  });

  it('refuses an unbounded radius, which would be a table scan (§17)', () => {
    expect(radiusMetresSchema.safeParse(20_000_000).success).toBe(false);
  });
});

describe('boundingBoxSchema', () => {
  const recife = { north: -8.0, south: -8.1, east: -34.8, west: -34.95 };

  it('accepts a well-formed viewport', () => {
    expect(boundingBoxSchema.safeParse(recife).success).toBe(true);
  });

  it('accepts string parameters, as they arrive from a query string', () => {
    const parsed = boundingBoxSchema.safeParse({
      north: '-8.0',
      south: '-8.1',
      east: '-34.8',
      west: '-34.95',
    });
    expect(parsed.success && parsed.data.north).toBe(-8.0);
  });

  it('rejects north below south', () => {
    const parsed = boundingBoxSchema.safeParse({ ...recife, north: -8.2 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a degenerate box where north equals south', () => {
    expect(boundingBoxSchema.safeParse({ ...recife, north: recife.south }).success).toBe(false);
  });

  /**
   * Antimeridian (§19). A viewport straddling ±180° arrives with west > east and
   * needs to be split into two queries. V1 rejects it by name rather than returning
   * a silently empty result.
   */
  it('rejects a viewport crossing the antimeridian, and says so', () => {
    const parsed = boundingBoxSchema.safeParse({
      north: 10,
      south: -10,
      west: 179,
      east: -179,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(' ')).toMatch(/antimeridian/i);
    }
  });

  it('rejects a viewport wider than the span cap', () => {
    const tooWide = {
      north: 0,
      south: -(BBOX_MAX_SPAN_DEGREES + 1),
      east: 0,
      west: -1,
    };
    expect(boundingBoxSchema.safeParse(tooWide).success).toBe(false);
  });

  it('rejects a world-spanning viewport', () => {
    const world = { north: 89, south: -89, east: 179, west: -179 };
    expect(boundingBoxSchema.safeParse(world).success).toBe(false);
  });

  it('rejects out-of-range corners', () => {
    expect(boundingBoxSchema.safeParse({ ...recife, north: 91 }).success).toBe(false);
    expect(boundingBoxSchema.safeParse({ ...recife, west: -181 }).success).toBe(false);
  });

  it('rejects a missing corner rather than defaulting it to zero', () => {
    expect(boundingBoxSchema.safeParse({ ...recife, east: '' }).success).toBe(false);
  });
});
