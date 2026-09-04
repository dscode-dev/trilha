import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { InvalidCredentialsError } from '../domain/identity-errors.js';
import { SessionRevocationReason } from '../domain/user.js';
import { PasswordHasher } from '../infrastructure/password-hasher.js';
import { UserRepository } from '../infrastructure/user.repository.js';
import { SessionRepository } from '../infrastructure/session.repository.js';
import { AuthAuditRepository, AuthEventType } from '../infrastructure/auth-audit.repository.js';

export interface ChangePasswordInput {
  userId: string;
  sessionId: string;
  currentPassword: string;
  newPassword: string;
  requestId: string | null;
  ipHash: string | null;
}

/**
 * Replaces the account password (§24, §56).
 *
 * **Policy: every session is revoked, the caller's included.** Changing a password is
 * what someone does when they think an account is compromised, so any session an
 * attacker holds must die — and there is no way to tell which of the live sessions is
 * the attacker's. The user signs in again on this device; that cost is small and
 * predictable, and the alternative silently preserves the attacker's access.
 *
 * Access tokens already issued stay valid until they expire (≤ 10 minutes by default).
 * Introducing a global token blacklist to close that window would add Redis to the
 * critical path of every request for a bounded exposure the short TTL already caps
 * (§20, §56).
 */
@Injectable()
export class ChangePasswordUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuthAuditRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChangePasswordUseCase.name);
  }

  async execute(input: ChangePasswordInput): Promise<{ revokedSessions: number }> {
    const currentHash = await this.users.findPasswordHash(input.userId);
    if (currentHash === undefined) throw new InvalidCredentialsError();

    /* Proving possession of the current password is what stops a stolen access token
       from being upgraded into permanent account takeover. */
    if (!(await this.hasher.verify(currentHash, input.currentPassword))) {
      await this.audit.record({
        eventType: AuthEventType.LOGIN_FAILED,
        userId: input.userId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        ipHash: input.ipHash,
        metadata: { reason: 'CHANGE_PASSWORD_BAD_CURRENT' },
      });
      throw new InvalidCredentialsError();
    }

    const newHash = await this.hasher.hash(input.newPassword);
    const now = new Date();
    let revokedSessions = 0;

    /* Credential update and session revocation commit together: a password change
       that left old sessions alive would be a false sense of security. */
    await this.users.changePassword(input.userId, newHash, async (tx) => {
      revokedSessions = await this.sessions.revokeAllSessions(
        input.userId,
        SessionRevocationReason.PASSWORD_CHANGED,
        now,
        tx,
      );
    });

    await this.audit.record({
      eventType: AuthEventType.PASSWORD_CHANGED,
      userId: input.userId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      ipHash: input.ipHash,
      metadata: { revokedSessions },
    });

    this.logger.info(
      { event: 'auth.password_changed', userId: input.userId, revokedSessions },
      'Password changed; all sessions revoked',
    );

    return { revokedSessions };
  }
}
