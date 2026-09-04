import { Injectable } from '@nestjs/common';
import { SessionRepository } from '../infrastructure/session.repository.js';
import { TokenService } from '../infrastructure/token.service.js';
import type { DeviceContext } from '../domain/user.js';

/** What a client receives after any successful authentication. */
export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
}

/**
 * The single place a session is created (§11).
 *
 * Register and login both route through here, so there is exactly one implementation
 * of "what it means to be signed in". Two paths would eventually diverge, and the
 * divergence would be a security bug rather than a cosmetic one.
 */
@Injectable()
export class SessionIssuer {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly tokens: TokenService,
  ) {}

  async issue(userId: string, device: DeviceContext, now: Date): Promise<IssuedSession> {
    const expiresAt = new Date(now.getTime() + this.tokens.refreshTokenTtlSeconds * 1_000);

    const session = await this.sessions.createSession(userId, expiresAt, device);
    const refresh = this.tokens.issueRefreshToken();

    await this.sessions.storeRefreshToken(session.id, refresh.tokenHash, expiresAt);

    const accessToken = await this.tokens.issueAccessToken({ sub: userId, sid: session.id });

    return {
      sessionId: session.id,
      accessToken,
      refreshToken: refresh.token,
      accessTokenExpiresInSeconds: this.tokens.accessTokenTtlSeconds,
    };
  }
}
