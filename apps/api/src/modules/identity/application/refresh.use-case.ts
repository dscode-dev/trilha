import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { SessionExpiredError } from '../domain/identity-errors.js';
import { SessionRevocationReason } from '../domain/user.js';
import { SessionRepository } from '../infrastructure/session.repository.js';
import { TokenService } from '../infrastructure/token.service.js';
import { AuthAuditRepository, AuthEventType } from '../infrastructure/auth-audit.repository.js';

export interface RefreshInput {
  refreshToken: string;
  requestId: string | null;
  ipHash: string | null;
}

export interface RefreshOutput {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
}

/**
 * Rotates a refresh token (§15, §16, §17).
 *
 * Rotation is single-use: the presented token is consumed and a new one issued. The
 * consume step is a conditional UPDATE in PostgreSQL, so two simultaneous refreshes
 * of the same token cannot both succeed — see
 * `SessionRepository.consumeRefreshToken`.
 *
 * **Reuse policy.** Presenting an already-rotated token means the token was captured,
 * or the client is replaying. Either way the session is treated as compromised: the
 * whole session — the token family — is revoked, every token under it dies with it,
 * and the caller is rejected. A legitimate client that lost a race is signed out too;
 * that is the intended trade, because the alternative is letting a thief keep a live
 * session.
 */
@Injectable()
export class RefreshUseCase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly tokens: TokenService,
    private readonly audit: AuthAuditRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RefreshUseCase.name);
  }

  async execute(input: RefreshInput): Promise<RefreshOutput> {
    const now = new Date();
    const tokenHash = this.tokens.hashRefreshToken(input.refreshToken);
    const result = await this.sessions.consumeRefreshToken(tokenHash, now);

    if (result.outcome === 'ALREADY_USED') {
      await this.handleReuse(result.sessionId, input, now);
      throw new SessionExpiredError(
        'Your session has ended for security reasons. Please sign in again.',
      );
    }

    if (result.outcome !== 'CONSUMED') {
      await this.audit.record({
        eventType: AuthEventType.REFRESH_FAILED,
        sessionId: result.outcome === 'UNUSABLE' ? result.sessionId : null,
        requestId: input.requestId,
        ipHash: input.ipHash,
        metadata: { reason: result.outcome },
      });
      throw new SessionExpiredError();
    }

    const session = await this.sessions.findSession(result.token.sessionId);
    if (session === undefined) throw new SessionExpiredError();

    /* Issue the replacement, then link it so the rotation chain stays walkable. */
    const replacement = this.tokens.issueRefreshToken();
    const replacementId = await this.sessions.storeRefreshToken(
      session.id,
      replacement.tokenHash,
      session.expiresAt,
    );
    await this.sessions.linkReplacement(result.token.id, replacementId);
    await this.sessions.touchSession(session.id, now);

    const accessToken = await this.tokens.issueAccessToken({
      sub: session.userId,
      sid: session.id,
    });

    await this.audit.record({
      eventType: AuthEventType.REFRESH_SUCCEEDED,
      userId: session.userId,
      sessionId: session.id,
      requestId: input.requestId,
      ipHash: input.ipHash,
    });

    return {
      sessionId: session.id,
      accessToken,
      refreshToken: replacement.token,
      accessTokenExpiresInSeconds: this.tokens.accessTokenTtlSeconds,
    };
  }

  /** Revokes the compromised family and records the detection prominently. */
  private async handleReuse(sessionId: string, input: RefreshInput, now: Date): Promise<void> {
    const session = await this.sessions.findSession(sessionId);

    await this.sessions.revokeSession(
      sessionId,
      SessionRevocationReason.REFRESH_REUSE_DETECTED,
      now,
    );

    await this.audit.record({
      eventType: AuthEventType.REFRESH_REUSE_DETECTED,
      userId: session?.userId ?? null,
      sessionId,
      requestId: input.requestId,
      ipHash: input.ipHash,
      metadata: { action: 'SESSION_REVOKED' },
    });

    /* `warn`, not `info`: this is the signal that a refresh token escaped the device
       it was issued to. */
    this.logger.warn(
      { event: 'auth.refresh.reuse_detected', sessionId, userId: session?.userId },
      'Refresh token reuse detected; session revoked',
    );
  }
}
