import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Identity schema (PR-01).
 *
 * Four concerns are kept in separate tables on purpose (constitution §Domain):
 * account identity (`users`), secrets (`credentials`), public presentation
 * (`user_profiles`) and authenticated device state (`sessions`). Collapsing them
 * would mean a profile read touches password material.
 *
 * Identifiers use PostgreSQL 18's native `uuidv7()`: non-enumerable as the
 * constitution requires (§21), and time-ordered, so primary-key inserts stay
 * local in the index instead of scattering like uuid v4.
 */

/** Account lifecycle. Only what PR-01 can actually reach — no speculative states. */
export const userStatus = pgEnum('user_status', ['ACTIVE', 'DISABLED', 'PENDING']);

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    /** As the user typed it, trimmed. Kept for display and correspondence. */
    email: text('email').notNull(),

    /**
     * Case-folded email, computed by the database.
     *
     * A generated column cannot be bypassed by application code, a raw SQL insert,
     * or a future service that forgets to normalise — which is exactly what §7
     * warns against. The unique index sits on this column, so `Foo@Example.com`
     * and `foo@example.com` are one identity by construction.
     */
    emailNormalized: text('email_normalized')
      .notNull()
      .generatedAlwaysAs(sql`lower(email)`),

    status: userStatus('status').notNull().default('ACTIVE'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_normalized_key').on(table.emailNormalized)],
);

export const credentials = pgTable('credentials', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),

  /** One password credential per user in V1; unique enforces it. */
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Full PHC-format Argon2id string: algorithm, parameters, salt and digest. */
  passwordHash: text('password_hash').notNull(),

  /**
   * Parameters are embedded in the PHC string, but recording the algorithm
   * separately makes "which accounts still use the old KDF?" a plain query when
   * parameters are raised later.
   */
  algorithm: text('algorithm').notNull().default('argon2id'),

  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userProfiles = pgTable(
  'user_profiles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** As chosen, preserving the user's capitalisation for display. */
    username: text('username').notNull(),

    /** Case-folded username; same database-enforced reasoning as the email (§8). */
    usernameNormalized: text('username_normalized')
      .notNull()
      .generatedAlwaysAs(sql`lower(username)`),

    displayName: text('display_name').notNull(),
    bio: text('bio'),

    /**
     * Always null in PR-01. Object storage is not part of this PR, and inventing
     * an upload path would be a mock presented as implementation (§29).
     */
    avatarUrl: text('avatar_url'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_profiles_username_normalized_key').on(table.usernameNormalized)],
);

/**
 * One authenticated installation. A session is also the refresh-token *family*:
 * detecting reuse revokes the session, which invalidates every token issued under it.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** Advanced on refresh only, never per authenticated request (§19). */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Machine-readable cause, e.g. `LOGOUT`, `REFRESH_REUSE_DETECTED`. */
    revokedReason: text('revoked_reason'),

    /* Client-declared, for a "your devices" view. No fingerprinting (§18). */
    deviceName: text('device_name'),
    platform: text('platform'),
    appVersion: text('app_version'),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);

/**
 * Refresh tokens. Only the hash is stored, never the token itself (§14).
 *
 * `usedAt` is what makes rotation single-use, and a conditional UPDATE on it is
 * what makes concurrent rotation safe (§17) — see `SessionRepository.consumeRefreshToken`.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),

    /** SHA-256 of the opaque token, hex encoded. Unique: a hash identifies one token. */
    tokenHash: text('token_hash').notNull().unique(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Set exactly once, by the rotation that consumes this token. */
    usedAt: timestamp('used_at', { withTimezone: true }),

    /** The token issued in its place. Makes a rotation chain reconstructible. */
    replacedByTokenId: uuid('replaced_by_token_id').references(
      (): AnyPgColumn => refreshTokens.id,
      { onDelete: 'set null' },
    ),
  },
  (table) => [index('refresh_tokens_session_id_idx').on(table.sessionId)],
);

/** Authentication events the auth type enumerates. Append-only. */
export const authEventType = pgEnum('auth_event_type', [
  'REGISTER_SUCCEEDED',
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'REFRESH_SUCCEEDED',
  'REFRESH_FAILED',
  'REFRESH_REUSE_DETECTED',
  'LOGOUT',
  'LOGOUT_ALL',
  'PASSWORD_CHANGED',
  'PROFILE_UPDATED',
  'RATE_LIMITED',
]);

/**
 * Security-relevant authentication history.
 *
 * `userId` is nullable because a failed login for an unknown address has no user to
 * attribute it to, and inventing one would defeat the point. Never contains
 * passwords, tokens or authorization headers (§28).
 */
export const authAuditEvents = pgTable(
  'auth_audit_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),

    eventType: authEventType('event_type').notNull(),

    /** Ties an event back to the HTTP request that produced it (§58). */
    requestId: text('request_id'),

    /**
     * HMAC of the client address, never the address itself.
     *
     * Enough to answer "same origin?" for abuse investigation without retaining an
     * identifier that is personal data under GDPR (§18, §48).
     */
    ipHash: text('ip_hash'),

    /** Non-sensitive structured context, e.g. `{ "reason": "INVALID_CREDENTIALS" }`. */
    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_audit_events_user_id_created_at_idx').on(table.userId, table.createdAt)],
);
