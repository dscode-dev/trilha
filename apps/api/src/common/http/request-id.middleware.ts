import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER, runWithRequestContext } from './request-context.js';

/** Bounds what we echo back, so a hostile header cannot poison logs or responses. */
const MAX_INBOUND_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]+$/;

/**
 * Establishes the correlation id for every request (§12).
 *
 * An inbound `x-request-id` is honoured so a trace survives across services, but
 * only when it is short and character-safe; anything else is replaced rather than
 * rejected, because a malformed header should not fail a user's request.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = normaliseInboundRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();

    req.headers[REQUEST_ID_HEADER] = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    runWithRequestContext({ requestId }, () => {
      next();
    });
  }
}

export function normaliseInboundRequestId(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INBOUND_REQUEST_ID_LENGTH) return undefined;
  if (!SAFE_REQUEST_ID.test(trimmed)) return undefined;

  return trimmed;
}
