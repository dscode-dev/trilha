/**
 * Hand-built Matrix API fixtures (§71).
 *
 * Written from the documented response shape rather than captured from a live call:
 * a captured payload would carry account-shaped data and would tempt someone to paste
 * a real token alongside it. Values are plausible for Recife → João Pessoa with two
 * places along the way.
 *
 * Layout throughout: index 0 is the origin, 1 the destination, 2+ the via-points.
 */

/** Baseline 6,480 s; via[0] adds 420 s, via[1] adds 2,400 s. */
export const matrixTwoCandidates = {
  code: 'Ok',
  durations: [
    [0, 6_480, 2_900, 4_100],
    [6_480, 0, 4_000, 4_780],
    [2_900, 4_000, 0, 1_500],
    [4_100, 4_780, 1_500, 0],
  ],
  distances: [
    [0, 105_060, 47_000, 66_000],
    [105_060, 0, 61_460, 44_060],
    [47_000, 61_460, 0, 24_000],
    [66_000, 44_060, 24_000, 0],
  ],
};

/** The second via-point cannot be reached by road. */
export const matrixUnreachableCandidate = {
  code: 'Ok',
  durations: [
    [0, 6_480, 2_900, null],
    [6_480, 0, 4_000, null],
    [2_900, 4_000, 0, null],
    [null, null, null, 0],
  ],
  distances: [
    [0, 105_060, 47_000, null],
    [105_060, 0, 61_460, null],
    [47_000, 61_460, 0, null],
    [null, null, null, 0],
  ],
};

/** The endpoints themselves cannot be connected — nothing in the batch is usable. */
export const matrixNoBaseline = {
  code: 'Ok',
  durations: [
    [0, null, 2_900],
    [null, 0, 4_000],
    [2_900, 4_000, 0],
  ],
  distances: [
    [0, null, 47_000],
    [null, 0, 61_460],
    [47_000, 61_460, 0],
  ],
};

/** A matrix whose dimensions do not match the request. */
export const matrixWrongShape = {
  code: 'Ok',
  durations: [
    [0, 6_480],
    [6_480, 0],
  ],
  distances: [
    [0, 105_060],
    [105_060, 0],
  ],
};

/** Distances omitted entirely, as an older or degraded response might. */
export const matrixDurationsOnly = {
  code: 'Ok',
  durations: [
    [0, 6_480, 2_900],
    [6_480, 0, 4_000],
    [2_900, 4_000, 0],
  ],
};

export const matrixProfileNotFound = {
  code: 'ProfileNotFound',
  message: 'Profile not found',
};
