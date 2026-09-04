import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { SessionRevocationReason } from '../domain/user.js';
import { SessionRepository } from '../infrastructure/session.repository.js';
import { AuthAuditRepository, AuthEventType } from '../infrastructure/auth-audit.repository.js';

export interface LogoutInput {
  userId: string;
  sessionId: string;
  requestId: string | null;
  ipHash: string | null;
}

/**
 * Ends sessions (§20, §21).
 *
 * Revoking a session invalidates its refresh tokens immediately. The access token
 * already in the client's hands stays valid until it expires — at most
 * `JWT_ACCESS_TTL_SECONDS`. That is a deliberate trade: checking a revocation list on
 * every request would put Redis on the critical path of all authenticated traffic, and
 * a short TTL bounds the exposure to minutes (§20, §56).
 */
@Injectable()
export class SessionLifecycleUseCase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly audit: AuthAuditRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SessionLifecycleUseCase.name);
  }

  /** Ends the caller's own session. Idempotent. */
  async logout(input: LogoutInput): Promise<void> {
    await this.sessions.revokeSession(input.sessionId, SessionRevocationReason.LOGOUT, new Date());

    await this.audit.record({
      eventType: AuthEventType.LOGOUT,
      userId: input.userId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      ipHash: input.ipHash,
    });

    this.logger.info({ event: 'auth.logout', userId: input.userId }, 'Session revoked');
  }

  /**
   * Ends every session for the user, the caller's own included.
   *
   * Including the current session is the point: this is what someone taps when they
   * believe an account is compromised, and leaving the invoking device signed in would
   * make the guarantee conditional on which device happened to be used.
   */
  async logoutAll(input: LogoutInput): Promise<{ revokedCount: number }> {
    const revokedCount = await this.sessions.revokeAllSessions(
      input.userId,
      SessionRevocationReason.LOGOUT_ALL,
      new Date(),
    );

    await this.audit.record({
      eventType: AuthEventType.LOGOUT_ALL,
      userId: input.userId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      ipHash: input.ipHash,
      metadata: { revokedCount },
    });

    this.logger.info(
      { event: 'auth.logout_all', userId: input.userId, revokedCount },
      'All sessions revoked',
    );

    return { revokedCount };
  }
}
