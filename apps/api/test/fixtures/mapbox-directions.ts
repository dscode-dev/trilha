/**
 * Sanitised fixtures shaped like Mapbox Directions v5 responses (§69).
 *
 * Hand-built from the documented schema rather than captured from a live call, so
 * there is no chance of a token, a session id or a real user's journey ending up in
 * the repository. Used only by tests — never by a production code path.
 */

/** A short Recife→Olinda-shaped success, trimmed to a handful of positions. */
export const directionsSuccess = {
  code: 'Ok',
  routes: [
    {
      distance: 105_060.4,
      duration: 6_480.2,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-34.8711, -8.0631],
          [-34.86, -7.98],
          [-34.85, -7.85],
          [-34.84, -7.6],
          [-34.85, -7.4],
          [-34.8631, -7.115],
        ],
      },
      legs: [{ distance: 105_060.4, duration: 6_480.2, summary: 'BR-101' }],
    },
  ],
  waypoints: [],
};

/** The provider understood the request but the points cannot be connected. */
export const directionsNoRoute = { code: 'NoRoute', message: 'No route found' };

/** A response whose geometry is not a LineString. */
export const directionsWrongGeometryType = {
  code: 'Ok',
  routes: [
    {
      distance: 100,
      duration: 60,
      geometry: { type: 'Point', coordinates: [-34.87, -8.06] },
      legs: [],
    },
  ],
};

/** A LineString with a single position — not a line. */
export const directionsSinglePoint = {
  code: 'Ok',
  routes: [
    {
      distance: 100,
      duration: 60,
      geometry: { type: 'LineString', coordinates: [[-34.87, -8.06]] },
      legs: [],
    },
  ],
};

/** A position outside valid coordinate bounds. */
export const directionsOutOfBounds = {
  code: 'Ok',
  routes: [
    {
      distance: 100,
      duration: 60,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-34.87, -8.06],
          [-34.87, 91],
        ],
      },
      legs: [],
    },
  ],
};

/** Metrics missing entirely. */
export const directionsMissingMetrics = {
  code: 'Ok',
  routes: [
    {
      geometry: {
        type: 'LineString',
        coordinates: [
          [-34.87, -8.06],
          [-34.86, -7.11],
        ],
      },
      legs: [],
    },
  ],
};

/** Valid route with no legs array — the adapter must synthesise one. */
export const directionsNoLegs = {
  code: 'Ok',
  routes: [
    {
      distance: 500,
      duration: 120,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-34.87, -8.06],
          [-34.86, -8.05],
        ],
      },
    },
  ],
};
