import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { authAuditEvents } from '../../../infrastructure/database/schema/identity.js';

/** Event vocabulary. Mirrors the `auth_event_type` enum. */
export const AuthEventType = {
  REGISTER_SUCCEEDED: 'REGISTER_SUCCEEDED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  REFRESH_SUCCEEDED: 'REFRESH_SUCCEEDED',
  REFRESH_FAILED: 'REFRESH_FAILED',
  REFRESH_REUSE_DETECTED: 'REFRESH_REUSE_DETECTED',
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PROFILE_UPDATED: 'PROFILE_UPDATED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type AuthEventType = (typeof AuthEventType)[keyof typeof AuthEventType];

export interface AuthAuditInput {
  eventType: AuthEventType;
  userId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  ipHash?: string | null;
  /** Non-sensitive context only. Never a credential, token or header. */
  metadata?: Record<string, unknown> | null;
}

/**
 * Append-only authentication history (§28).
 *
 * Never records passwords, tokens or authorization headers — the input type offers no
 * field for them, and callers pass reasons and identifiers rather than payloads.
 */
@Injectable()
export class AuthAuditRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthAuditRepository.name);
  }

  /**
   * Writes one event.
   *
   * Audit failure must not fail the operation being audited: a user should not be
   * unable to log in because the audit table is full. The write is best-effort and a
   * failure is escalated to the log, which is itself a durable sink.
   */
  async record(input: AuthAuditInput): Promise<void> {
    try {
      await this.database.db.insert(authAuditEvents).values({
        eventType: input.eventType,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        requestId: input.requestId ?? null,
        ipHash: input.ipHash ?? null,
        metadata: input.metadata ?? null,
      });
    } catch (error) {
      this.logger.error(
        { event: 'auth.audit.write_failed', auditEvent: input.eventType, err: error },
        'Failed to persist auth audit event',
      );
    }
  }
}
