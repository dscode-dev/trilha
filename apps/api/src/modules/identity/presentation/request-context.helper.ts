import type { Request } from 'express';
import { getRequestId } from '../../../common/http/request-context.js';
import type { DeviceContext } from '../domain/user.js';
import type { TokenService } from '../infrastructure/token.service.js';

/** Device fields as they arrive on the wire. */
export interface DeviceInput {
  deviceName?: string | undefined;
  platform?: string | undefined;
  appVersion?: string | undefined;
}

export function toDeviceContext(input: DeviceInput | undefined): DeviceContext {
  return {
    deviceName: input?.deviceName ?? null,
    platform: input?.platform ?? null,
    appVersion: input?.appVersion ?? null,
  };
}

/**
 * Correlation and client-origin details for an audit record (§58).
 *
 * The address is hashed immediately and the raw value is never returned, so no caller
 * can accidentally persist or log it.
 */
export function auditContext(
  request: Request,
  tokens: TokenService,
): { requestId: string | null; ipHash: string | null } {
  const ip = clientIp(request);
  return {
    requestId: getRequestId() ?? null,
    ipHash: ip === undefined ? null : tokens.hashIpAddress(ip),
  };
}

/**
 * Best-effort client address.
 *
 * `req.ip` already honours `trust proxy` when Express is configured for it; behind an
 * unconfigured proxy this collapses to the proxy's address, which degrades audit
 * granularity but never misattributes to a spoofable header.
 */
export function clientIp(request: Request): string | undefined {
  const ip = request.ip ?? request.socket.remoteAddress;
  return ip === undefined || ip.length === 0 ? undefined : ip;
}
