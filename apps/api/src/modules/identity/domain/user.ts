/**
 * Identity domain types.
 *
 * Plain data and pure functions only — no Nest, no Drizzle, no HTTP. Anything here
 * must stay testable with no container and no database (constitution §3).
 */

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  PENDING: 'PENDING',
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export interface User {
  readonly id: string;
  readonly email: string;
  readonly status: UserStatus;
  readonly createdAt: Date;
}

export interface UserProfile {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly avatarUrl: string | null;
}

export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** Client-declared context for a login, used only to label a session (§18). */
export interface DeviceContext {
  readonly deviceName: string | null;
  readonly platform: string | null;
  readonly appVersion: string | null;
}

/**
 * Whether an account may authenticate.
 *
 * `PENDING` is permitted to sign in: PR-01 has no email verification, so treating it
 * as a lockout would strand accounts with no way to recover.
 */
export function canAuthenticate(status: UserStatus): boolean {
  return status === UserStatus.ACTIVE || status === UserStatus.PENDING;
}

/** A session is usable only while unrevoked and unexpired. */
export function isSessionUsable(
  session: Pick<Session, 'revokedAt' | 'expiresAt'>,
  now: Date,
): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

/** Why a session was revoked. Recorded for audit and support. */
export const SessionRevocationReason = {
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  REFRESH_REUSE_DETECTED: 'REFRESH_REUSE_DETECTED',
} as const;

export type SessionRevocationReason =
  (typeof SessionRevocationReason)[keyof typeof SessionRevocationReason];
