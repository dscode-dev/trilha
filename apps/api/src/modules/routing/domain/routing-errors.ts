import { HttpStatus } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { ErrorCode } from '../../../common/errors/error-codes.js';

/**
 * Routing failures, normalised (§22).
 *
 * A provider's own error shape never reaches a client: its payloads carry URLs,
 * internal identifiers and sometimes the access token that produced them. Each of
 * these maps a class of upstream outcome onto something a caller can act on.
 */

/** The provider could not connect the two points — an island, a pedestrian-only area. */
export class RouteNotFoundError extends AppError {
  constructor() {
    super({
      code: ErrorCode.ROUTE_NOT_FOUND,
      message: 'No driving route connects those two points.',
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  }
}

/**
 * Origin and destination are effectively the same point.
 *
 * Rejected before the provider is called: a zero-length route is meaningless, and
 * asking a metered API for one wastes a request.
 */
export class DegenerateRouteError extends AppError {
  constructor(minimumMeters: number) {
    super({
      code: ErrorCode.INVALID_ROUTE_REQUEST,
      message: 'Origin and destination are too close together to route between.',
      httpStatus: HttpStatus.BAD_REQUEST,
      details: { minimumSeparationMeters: minimumMeters },
    });
  }
}

/** The endpoints are implausibly far apart — usually swapped or mistyped coordinates. */
export class RouteTooLongError extends AppError {
  constructor(maximumMeters: number) {
    super({
      code: ErrorCode.INVALID_ROUTE_REQUEST,
      message: 'Those points are too far apart to route between.',
      httpStatus: HttpStatus.BAD_REQUEST,
      details: { maximumSeparationMeters: maximumMeters },
    });
  }
}

/** The upstream call exceeded its deadline. Retryable. */
export class RoutingProviderTimeoutError extends AppError {
  constructor(cause?: unknown) {
    super({
      code: ErrorCode.PROVIDER_TIMEOUT,
      message: 'The routing service took too long to respond. Please try again.',
      httpStatus: HttpStatus.GATEWAY_TIMEOUT,
      isExpected: false,
      cause,
    });
  }
}

/** The provider is down, unreachable, or returned something unusable. */
export class RoutingProviderUnavailableError extends AppError {
  constructor(cause?: unknown) {
    super({
      code: ErrorCode.PROVIDER_UNAVAILABLE,
      message: 'Routing is unavailable right now. Please try again shortly.',
      httpStatus: HttpStatus.BAD_GATEWAY,
      isExpected: false,
      cause,
    });
  }
}

/**
 * The provider throttled us.
 *
 * Distinct from our own rate limit: this one means Trilha as a whole has exceeded its
 * quota, so it is an operational signal, not a message about this caller's behaviour.
 */
export class RoutingProviderRateLimitedError extends AppError {
  constructor() {
    super({
      code: ErrorCode.PROVIDER_RATE_LIMITED,
      message: 'Routing is briefly unavailable. Please try again in a moment.',
      httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
      isExpected: false,
    });
  }
}

/** The provider accepted the request but returned a route we cannot trust. */
export class InvalidRouteGeometryError extends AppError {
  constructor(reason: string) {
    super({
      code: ErrorCode.PROVIDER_UNAVAILABLE,
      message: 'Routing returned an unusable result. Please try again.',
      httpStatus: HttpStatus.BAD_GATEWAY,
      details: { reason },
      isExpected: false,
    });
  }
}

/**
 * More points than one provider request can carry (PR-05, §17).
 *
 * A caller's mistake rather than an upstream failure, so it is a 400: the adapter
 * publishes its coordinate ceiling, and Trilha's own limit on stops sits below it.
 */
export class TooManyWaypointsError extends AppError {
  constructor(maximumWaypoints: number) {
    super({
      code: ErrorCode.INVALID_ROUTE_REQUEST,
      message: 'That is more stops than a single route request can carry.',
      httpStatus: HttpStatus.BAD_REQUEST,
      details: { maximumWaypoints },
    });
  }
}
