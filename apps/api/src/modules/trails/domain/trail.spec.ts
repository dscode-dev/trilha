import { describe, expect, it } from 'vitest';
import {
  MAX_TRAIL_STOPS,
  TrailStatus,
  TrailStopSource,
  isRouteCurrent,
  trailDetour,
  type Trail,
} from './trail.js';

/** Trail invariants that hold without a database (§87). */
describe('Trail domain', () => {
  const trail = (overrides: Partial<Trail> = {}): Trail => ({
    id: '00000000-0000-0000-0000-000000000001',
    ownerUserId: '00000000-0000-0000-0000-0000000000aa',
    status: TrailStatus.DRAFT,
    origin: { latitude: -8.0631, longitude: -34.8711, placeId: null, label: 'Recife' },
    destination: { latitude: -7.115, longitude: -34.8631, placeId: null, label: 'João Pessoa' },
    stops: [],
    revision: 3,
    route: {
      geometry: {
        type: 'LineString',
        coordinates: [
          [-34.8711, -8.0631],
          [-34.8631, -7.115],
        ],
      },
      bounds: { north: -7.115, south: -8.0631, east: -34.8631, west: -34.8711 },
      distanceMeters: 145_000,
      durationSeconds: 7_860,
      provider: 'fake',
      calculatedAt: new Date('2026-09-05T00:00:00Z'),
      revision: 3,
    },
    baseRoute: {
      distanceMeters: 121_000,
      durationSeconds: 6_480,
      calculatedAt: new Date('2026-09-05T00:00:00Z'),
    },
    createdAt: new Date('2026-09-05T00:00:00Z'),
    updatedAt: new Date('2026-09-05T00:00:00Z'),
    finalizedAt: null,
    ...overrides,
  });

  describe('stop ceiling (§14, §17)', () => {
    it('sits below what one provider request can carry', () => {
      /* Mapbox Directions accepts 25 coordinates on the driving profile; origin and
         destination take two, leaving 23. The margin is deliberate. */
      expect(MAX_TRAIL_STOPS).toBeLessThanOrEqual(23);
      expect(MAX_TRAIL_STOPS).toBeGreaterThan(0);
    });
  });

  describe('route currency (§22, §24)', () => {
    it('is current when the snapshot describes this revision', () => {
      expect(isRouteCurrent(trail({ revision: 3 }))).toBe(true);
    });

    it('is stale when the composition moved past the snapshot', () => {
      const stale = trail();
      expect(isRouteCurrent({ revision: 4, route: stale.route })).toBe(false);
    });

    it('is not current when no route has ever been calculated', () => {
      /* A trail created while the provider was unreachable (§26). */
      expect(isRouteCurrent(trail({ route: null }))).toBe(false);
    });
  });

  describe('detour (§38)', () => {
    it('measures the composed route against the same endpoints with no stops', () => {
      expect(trailDetour(trail())).toEqual({
        extraDistanceMeters: 24_000,
        extraDurationSeconds: 1_380,
      });
    });

    it('reports nothing rather than zero when the baseline is missing', () => {
      /* "Not measured" and "no detour" are different claims, and rendering the first
         as the second would state a fact Trilha does not have. */
      expect(trailDetour(trail({ baseRoute: null }))).toBeNull();
    });

    it('reports nothing when the route is missing', () => {
      expect(trailDetour(trail({ route: null }))).toBeNull();
    });

    it('never reports a negative detour', () => {
      const shorter = trail({
        baseRoute: {
          distanceMeters: 200_000,
          durationSeconds: 9_000,
          calculatedAt: new Date(),
        },
      });

      expect(trailDetour(shorter)).toEqual({
        extraDistanceMeters: 0,
        extraDurationSeconds: 0,
      });
    });

    it('is zero for a trail with no stops', () => {
      const withRoute = trail();
      const route = withRoute.route;
      if (route === null) throw new Error('fixture must carry a route');

      const direct = trail({
        route: { ...route, distanceMeters: 121_000, durationSeconds: 6_480 },
      });

      expect(trailDetour(direct)).toEqual({
        extraDistanceMeters: 0,
        extraDurationSeconds: 0,
      });
    });
  });

  describe('vocabulary', () => {
    it('has no social or publication state (§72, §108)', () => {
      const statuses: string[] = Object.values(TrailStatus);

      /* Publication is a later PR with rules of its own; a value reserved for it now
         is an invitation to use it before those rules exist. */
      expect(statuses).toEqual(['DRAFT', 'FINALIZED', 'ARCHIVED']);
      expect(statuses).not.toContain('PUBLISHED');
      expect(statuses).not.toContain('SHARED');
    });

    it('records where a stop came from, and cannot claim an AI origin (§11)', () => {
      const sources: string[] = Object.values(TrailStopSource);

      expect(sources).toEqual(['DISCOVERY', 'SEARCH', 'MANUAL']);
      expect(sources).not.toContain('AI');
    });

    it('exposes no rating, safety or visibility field (§108)', () => {
      const fields = Object.keys(trail());

      for (const forbidden of [/rating/i, /safety/i, /public/i, /slug/i, /share/i, /comment/i]) {
        expect(fields.filter((field) => forbidden.test(field))).toEqual([]);
      }
    });
  });
});
