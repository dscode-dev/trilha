import { HttpStatus } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { ErrorCode } from '../../../common/errors/error-codes.js';

/**
 * Trail failures, normalised (§78).
 *
 * Each is something a client can act on differently: a conflict means reload, a
 * duplicate means the stop is already there, a stale route means recalculate.
 * Collapsing them into a generic 400 would leave the app guessing.
 */

/**
 * Someone else's Trail, or one that does not exist.
 *
 * **Deliberately indistinguishable.** A 403 on a Trail belonging to another account
 * confirms that the id is real, which turns id enumeration into a way to count other
 * people's private compositions. 404 for both leaks nothing (§8, §53).
 */
export class TrailNotFoundError extends AppError {
  constructor() {
    super({
      code: ErrorCode.NOT_FOUND,
      message: 'Trail not found.',
      httpStatus: HttpStatus.NOT_FOUND,
    });
  }
}

/**
 * The client edited a revision that is no longer current (§25, §78).
 *
 * Never resolved by overwriting. The client reloads, sees what changed, and decides
 * again — which is the whole point of optimistic concurrency: a lost update is worse
 * than a retry, because nobody finds out about it.
 */
export class TrailRevisionConflictError extends AppError {
  constructor(currentRevision: number, expectedRevision: number) {
    super({
      code: ErrorCode.TRAIL_REVISION_CONFLICT,
      message: 'This trail changed while you were editing it. Reload and try again.',
      httpStatus: HttpStatus.CONFLICT,
      details: { currentRevision, expectedRevision },
    });
  }
}

export class TrailStopLimitError extends AppError {
  constructor(maximum: number) {
    super({
      code: ErrorCode.TRAIL_STOP_LIMIT_REACHED,
      message: `A trail can hold at most ${String(maximum)} stops.`,
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      details: { maximumStops: maximum },
    });
  }
}

/** The same Place twice in one Trail (§33). */
export class DuplicateTrailStopError extends AppError {
  constructor() {
    super({
      code: ErrorCode.TRAIL_STOP_DUPLICATE,
      message: 'That place is already a stop on this trail.',
      httpStatus: HttpStatus.CONFLICT,
    });
  }
}

/** A reorder that does not describe the same set of stops (§31). */
export class InvalidStopOrderError extends AppError {
  constructor(reason: string) {
    super({
      code: ErrorCode.INVALID_TRAIL_STOP_ORDER,
      message: reason,
      httpStatus: HttpStatus.BAD_REQUEST,
    });
  }
}

/**
 * Finalizing a Trail whose route does not match its composition (§22).
 *
 * "I'm done" has to mean the thing the user was looking at is the thing that gets
 * saved. A Trail finalized with a stale line would show a distance for a journey it
 * no longer describes.
 */
export class TrailRouteStaleError extends AppError {
  constructor() {
    super({
      code: ErrorCode.TRAIL_ROUTE_STALE,
      message: 'This trail has changes that have not been routed yet. Update the route first.',
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  }
}

/** A stop pointing at a Place that is not visible to readers (§24 of PR-04, §10). */
export class TrailStopPlaceUnavailableError extends AppError {
  constructor() {
    super({
      code: ErrorCode.TRAIL_STOP_PLACE_UNAVAILABLE,
      message: 'That place cannot be added to a trail.',
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  }
}
