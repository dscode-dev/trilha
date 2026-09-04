import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { refreshTokens, sessions } from '../../../infrastructure/database/schema/identity.js';
import type { DeviceContext, SessionRevocationReason } from '../domain/user.js';

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface RefreshTokenRecord {
  id: string;
  sessionId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/** Why a refresh attempt did not produce new tokens. */
export type ConsumeFailure =
  /** No row for this hash — forged, or from a session already deleted. */
  | { outcome: 'NOT_FOUND' }
  /**
   * The token exists but was already rotated. This is the reuse signal (§16): either
   * a stolen token is being replayed, or the legitimate holder lost the race. Both
   * are treated as compromise.
   */
  | { outcome: 'ALREADY_USED'; sessionId: string }
  /** Expired, or its session is expired/revoked. */
  | { outcome: 'UNUSABLE'; sessionId: string };

export type ConsumeResult = { outcome: 'CONSUMED'; token: RefreshTokenRecord } | ConsumeFailure;

/**
 * Persistence for sessions and refresh tokens.
 *
 * The rotation logic lives here rather than in a use case because its correctness is
 * a property of the SQL, not of the surrounding control flow (§17).
 */
@Injectable()
export class SessionRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async createSession(
    userId: string,
    expiresAt: Date,
    device: DeviceContext,
    tx?: DatabaseService['db'],
  ): Promise<SessionRecord> {
    const [row] = await (tx ?? this.db)
      .insert(sessions)
      .values({
        userId,
        expiresAt,
        deviceName: device.deviceName,
        platform: device.platform,
        appVersion: device.appVersion,
      })
      .returning({
        id: sessions.id,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      });

    if (row === undefined) throw new Error('Session insert returned no row');
    return row;
  }

  async storeRefreshToken(
    sessionId: string,
    tokenHash: string,
    expiresAt: Date,
    tx?: DatabaseService['db'],
  ): Promise<string> {
    const [row] = await (tx ?? this.db)
      .insert(refreshTokens)
      .values({ sessionId, tokenHash, expiresAt })
      .returning({ id: refreshTokens.id });

    if (row === undefined) throw new Error('Refresh token insert returned no row');
    return row.id;
  }

  /**
   * Atomically claims a refresh token for rotation.
   *
   * The guarantee that exactly one concurrent caller succeeds comes from the
   * `used_at IS NULL` predicate on the UPDATE, not from application code (§17):
   *
   *   1. Both transactions target the same row; PostgreSQL grants the row lock to one.
   *   2. The winner sets `used_at` and commits.
   *   3. The loser is released, re-evaluates the predicate against the *committed*
   *      row under READ COMMITTED, now finds `used_at IS NOT NULL`, and updates
   *      zero rows.
   *
   * So the loser observes `ALREADY_USED` — indistinguishable from a genuine replay,
   * which is the correct conservative reading (§16).
   *
   * The session's own validity is part of the same statement, so a revoked session
   * cannot have a token rotated out of it even if the token itself looks fine.
   */
  async consumeRefreshToken(tokenHash: string, now: Date): Promise<ConsumeResult> {
    const claimed = await this.db.execute<{
      id: string;
      session_id: string;
      expires_at: Date;
      used_at: Date | null;
    }>(sql`
      UPDATE refresh_tokens AS rt
         SET used_at = ${now}
        FROM sessions AS s
       WHERE rt.token_hash = ${tokenHash}
         AND rt.used_at IS NULL
         AND rt.expires_at > ${now}
         AND s.id = rt.session_id
         AND s.revoked_at IS NULL
         AND s.expires_at > ${now}
      RETURNING rt.id, rt.session_id, rt.expires_at, rt.used_at
    `);

    const row = claimed.rows[0];
    if (row !== undefined) {
      return {
        outcome: 'CONSUMED',
        token: {
          id: row.id,
          sessionId: row.session_id,
          expiresAt: row.expires_at,
          usedAt: row.used_at,
        },
      };
    }

    /* The claim failed. Establish *why*, because replay demands a different response
       from mere expiry. */
    const [existing] = await this.db
      .select({
        id: refreshTokens.id,
        sessionId: refreshTokens.sessionId,
        usedAt: refreshTokens.usedAt,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (existing === undefined) return { outcome: 'NOT_FOUND' };
    if (existing.usedAt !== null) {
      return { outcome: 'ALREADY_USED', sessionId: existing.sessionId };
    }
    return { outcome: 'UNUSABLE', sessionId: existing.sessionId };
  }

  /** Links a rotated token to its successor, keeping the chain reconstructible. */
  async linkReplacement(
    tokenId: string,
    replacementId: string,
    tx?: DatabaseService['db'],
  ): Promise<void> {
    await (tx ?? this.db)
      .update(refreshTokens)
      .set({ replacedByTokenId: replacementId })
      .where(eq(refreshTokens.id, tokenId));
  }

  async findSession(sessionId: string): Promise<SessionRecord | undefined> {
    const [row] = await this.db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    return row;
  }

  /** Revokes one session. Idempotent: an already-revoked session keeps its first reason. */
  async revokeSession(
    sessionId: string,
    reason: SessionRevocationReason,
    now: Date,
  ): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  /** Revokes every live session for a user. Returns how many were affected. */
  async revokeAllSessions(
    userId: string,
    reason: SessionRevocationReason,
    now: Date,
    tx?: DatabaseService['db'],
  ): Promise<number> {
    const revoked = await (tx ?? this.db)
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return revoked.length;
  }

  /**
   * Advances `lastUsedAt`. Called only on refresh, never per authenticated request,
   * so an active client produces one write per access-token lifetime instead of one
   * per API call (§19).
   */
  async touchSession(sessionId: string, now: Date, tx?: DatabaseService['db']): Promise<void> {
    await (tx ?? this.db)
      .update(sessions)
      .set({ lastUsedAt: now })
      .where(eq(sessions.id, sessionId));
  }
}
