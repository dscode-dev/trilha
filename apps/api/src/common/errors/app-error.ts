import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes.js';

/**
 * Structured detail attached to an error response.
 *
 * Only ever populated with values that are safe to show a client — never SQL,
 * stack traces, internal paths, or secrets (constitution §Engineering).
 */
export type ErrorDetails = Record<string, unknown>;

/**
 * Base class for errors the application raises deliberately.
 *
 * Carrying the HTTP status and machine code on the error keeps the transport
 * mapping in one place, so the wire contract never depends on which framework
 * exception a layer happened to throw.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: ErrorDetails | undefined;
  /** When false the filter logs at `error` and hides the message from clients. */
  readonly isExpected: boolean;

  constructor(params: {
    code: ErrorCode;
    message: string;
    httpStatus: number;
    details?: ErrorDetails;
    isExpected?: boolean;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = new.target.name;
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.details = params.details;
    this.isExpected = params.isExpected ?? true;
    Error.captureStackTrace(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: ErrorDetails) {
    super({
      code: ErrorCode.VALIDATION_ERROR,
      message,
      httpStatus: HttpStatus.BAD_REQUEST,
      ...(details === undefined ? {} : { details }),
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details?: ErrorDetails) {
    super({
      code: ErrorCode.NOT_FOUND,
      message,
      httpStatus: HttpStatus.NOT_FOUND,
      ...(details === undefined ? {} : { details }),
    });
  }
}

/**
 * A required downstream dependency (database, cache, …) could not serve the request.
 * Surfaces as 503 so callers and orchestrators can retry rather than treat it as a bug.
 */
export class DependencyUnavailableError extends AppError {
  constructor(dependency: string, cause?: unknown) {
    super({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      message: `Dependency "${dependency}" is unavailable`,
      httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
      details: { dependency },
      isExpected: false,
      cause,
    });
  }
}
