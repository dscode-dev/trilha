import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Injectable,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { getRequestId } from '../http/request-context.js';
import { AppError, type ErrorDetails } from './app-error.js';
import { ErrorCode } from './error-codes.js';
import { buildErrorResponse, type ErrorBody } from './error-response.js';

/**
 * Terminal error boundary for the HTTP transport (§11).
 *
 * Guarantees three things regardless of what was thrown:
 *   1. the response body always uses the `{ error: { code, message, requestId } }` envelope;
 *   2. the client never sees a stack trace, SQL, internal path or secret;
 *   3. the failure is logged once, with full context, on the server side.
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = getRequestId() ?? readRequestIdFromResponse(response) ?? 'unknown';
    const mapped = mapException(exception);

    const body: ErrorBody = {
      code: mapped.code,
      message: mapped.message,
      requestId,
      ...(mapped.details === undefined ? {} : { details: mapped.details }),
    };

    this.log(exception, mapped, { requestId, method: request.method, path: request.url });

    if (response.headersSent) return;
    response.status(mapped.httpStatus).json(buildErrorResponse(body));
  }

  private log(
    exception: unknown,
    mapped: MappedError,
    context: { requestId: string; method: string; path: string },
  ): void {
    const payload = {
      ...context,
      event: 'http.request.failed',
      errorCode: mapped.code,
      statusCode: mapped.httpStatus,
      /* The raw error goes to the log only — never to the client. */
      err: exception,
    };

    if (mapped.httpStatus >= SERVER_ERROR_THRESHOLD) {
      this.logger.error(payload, mapped.logMessage);
    } else {
      this.logger.warn(payload, mapped.logMessage);
    }
  }
}

interface MappedError {
  code: ErrorCode;
  /** Client-safe message. */
  message: string;
  httpStatus: number;
  details: ErrorDetails | undefined;
  /** Server-side message, may be more specific than `message`. */
  logMessage: string;
}

const GENERIC_INTERNAL_MESSAGE = 'An unexpected error occurred';

/** `HttpException.getStatus()` returns a plain number, not the `HttpStatus` enum. */
const SERVER_ERROR_THRESHOLD = 500;

const STATUS_TO_ERROR_CODE: ReadonlyMap<number, ErrorCode> = new Map([
  [HttpStatus.BAD_REQUEST, ErrorCode.BAD_REQUEST],
  [HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED],
  [HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN],
  [HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND],
  [HttpStatus.CONFLICT, ErrorCode.CONFLICT],
  [HttpStatus.PAYLOAD_TOO_LARGE, ErrorCode.PAYLOAD_TOO_LARGE],
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_MEDIA_TYPE],
  [HttpStatus.TOO_MANY_REQUESTS, ErrorCode.TOO_MANY_REQUESTS],
  [HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_UNAVAILABLE],
]);

export function mapException(exception: unknown): MappedError {
  if (exception instanceof AppError) {
    return {
      code: exception.code,
      message: exception.message,
      httpStatus: exception.httpStatus,
      details: exception.details,
      logMessage: exception.message,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      code: httpStatusToErrorCode(status),
      // Nest's built-in messages are client-safe; anything 5xx is still masked below.
      message:
        status >= SERVER_ERROR_THRESHOLD
          ? GENERIC_INTERNAL_MESSAGE
          : extractHttpExceptionMessage(exception),
      httpStatus: status,
      details: extractHttpExceptionDetails(exception),
      logMessage: exception.message,
    };
  }

  /* Express-convention errors (body-parser, CORS, …) carry a numeric `status` but
     are not HttpExceptions. Without this branch an oversized body would surface as
     a 500 instead of the 413 the client deserves. */
  const transportStatus = extractTransportStatus(exception);
  if (transportStatus !== undefined) {
    const isServerError = transportStatus >= SERVER_ERROR_THRESHOLD;
    return {
      code: httpStatusToErrorCode(transportStatus),
      /* A 4xx message from middleware describes the caller's own request, so it is
         safe to echo; 5xx is masked like any other internal failure. */
      message: isServerError
        ? GENERIC_INTERNAL_MESSAGE
        : truncate(errorMessage(exception), MAX_CLIENT_MESSAGE_LENGTH),
      httpStatus: transportStatus,
      details: undefined,
      logMessage: errorMessage(exception),
    };
  }

  /* Unknown throwable: assume it may contain anything and reveal nothing. */
  return {
    code: ErrorCode.INTERNAL_ERROR,
    message: GENERIC_INTERNAL_MESSAGE,
    httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
    details: undefined,
    logMessage: exception instanceof Error ? exception.message : 'Non-Error exception thrown',
  };
}

function httpStatusToErrorCode(status: number): ErrorCode {
  const mapped = STATUS_TO_ERROR_CODE.get(status);
  if (mapped !== undefined) return mapped;

  return status >= SERVER_ERROR_THRESHOLD ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST;
}

function extractHttpExceptionMessage(exception: HttpException): string {
  const payload: unknown = exception.getResponse();
  if (typeof payload === 'string') return payload;

  if (isRecord(payload)) {
    const { message } = payload;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return 'Request validation failed';
  }
  return exception.message;
}

/** Surfaces Nest's array-style validation messages, which are client-safe by design. */
function extractHttpExceptionDetails(exception: HttpException): ErrorDetails | undefined {
  const payload: unknown = exception.getResponse();
  if (!isRecord(payload)) return undefined;

  const { message } = payload;
  if (Array.isArray(message) && message.every((m): m is string => typeof m === 'string')) {
    return { issues: message };
  }
  return undefined;
}

const MAX_CLIENT_MESSAGE_LENGTH = 200;

/** Reads the `status`/`statusCode` convention used by Express middleware errors. */
export function extractTransportStatus(exception: unknown): number | undefined {
  if (!isRecord(exception)) return undefined;

  const raw = exception['status'] ?? exception['statusCode'];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;

  return raw >= 400 && raw <= 599 ? raw : undefined;
}

function errorMessage(exception: unknown): string {
  return exception instanceof Error ? exception.message : String(exception);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readRequestIdFromResponse(response: Response): string | undefined {
  const header = response.getHeader('x-request-id');
  return typeof header === 'string' ? header : undefined;
}
