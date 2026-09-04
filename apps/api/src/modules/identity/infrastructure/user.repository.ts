import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import {
  credentials,
  userProfiles,
  users,
} from '../../../infrastructure/database/schema/identity.js';
import type { UserStatus } from '../domain/user.js';

export interface UserWithProfile {
  id: string;
  email: string;
  status: UserStatus;
  createdAt: Date;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
}

export interface AuthenticationRecord {
  userId: string;
  email: string;
  status: UserStatus;
  passwordHash: string;
}

/** Distinguishes which unique constraint a write violated. */
export type UniqueViolation = 'EMAIL' | 'USERNAME' | null;

@Injectable()
export class UserRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Creates user, credential and profile as one unit (§30).
   *
   * A partial result here would be a genuine corruption — an account with no way to
   * sign in, or a credential with no owner — so all three inserts share a transaction
   * and fail together.
   */
  async createAccount(input: {
    email: string;
    passwordHash: string;
    username: string;
    displayName: string;
  }): Promise<{ userId: string }> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email: input.email })
        .returning({ id: users.id });

      if (user === undefined) throw new Error('User insert returned no row');

      await tx.insert(credentials).values({
        userId: user.id,
        passwordHash: input.passwordHash,
      });

      await tx.insert(userProfiles).values({
        userId: user.id,
        username: input.username,
        displayName: input.displayName,
      });

      return { userId: user.id };
    });
  }

  /**
   * Loads what login needs, in one query.
   *
   * Returns `undefined` for an unknown address; the caller must still perform a hash
   * comparison so that timing does not reveal which case occurred (§12).
   */
  async findForAuthentication(normalisedEmail: string): Promise<AuthenticationRecord | undefined> {
    const [row] = await this.db
      .select({
        userId: users.id,
        email: users.email,
        status: users.status,
        passwordHash: credentials.passwordHash,
      })
      .from(users)
      .innerJoin(credentials, eq(credentials.userId, users.id))
      .where(eq(users.emailNormalized, normalisedEmail))
      .limit(1);

    return row;
  }

  async findWithProfile(userId: string): Promise<UserWithProfile | undefined> {
    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        createdAt: users.createdAt,
        username: userProfiles.username,
        displayName: userProfiles.displayName,
        bio: userProfiles.bio,
        avatarUrl: userProfiles.avatarUrl,
      })
      .from(users)
      .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);

    return row;
  }

  async updateProfile(
    userId: string,
    changes: { username?: string; displayName?: string; bio?: string | null },
  ): Promise<void> {
    await this.db
      .update(userProfiles)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(userProfiles.userId, userId));
  }

  async findPasswordHash(userId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ passwordHash: credentials.passwordHash })
      .from(credentials)
      .where(eq(credentials.userId, userId))
      .limit(1);

    return row?.passwordHash;
  }

  /**
   * Replaces the stored credential and revokes every session in one transaction (§24).
   *
   * Both must happen together: a committed password change that left old sessions
   * alive would leave an attacker holding a working session after the victim
   * "secured" the account.
   */
  async changePassword(
    userId: string,
    passwordHash: string,
    revokeSessions: (
      tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    ) => Promise<unknown>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(credentials)
        .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
        .where(eq(credentials.userId, userId));

      await revokeSessions(tx);
    });
  }
}

/**
 * Maps a PostgreSQL unique-violation to the field that caused it.
 *
 * Registration checks availability first for a good error message, but two
 * simultaneous signups can still pass that check and collide at COMMIT. The database
 * is the arbiter; this turns its verdict back into a domain error (§29).
 */
export function classifyUniqueViolation(error: unknown): UniqueViolation {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  /* 23505 = unique_violation */
  if (candidate.code !== '23505') return null;

  const detail = `${asText(candidate.constraint)} ${asText(candidate.message)}`;
  if (detail.includes('users_email_normalized')) return 'EMAIL';
  if (detail.includes('user_profiles_username_normalized')) return 'USERNAME';
  return null;
}

/** Narrows an unknown driver field to text without stringifying an object. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Case-insensitive availability probes, used for pre-flight error messages. */
@Injectable()
export class IdentityAvailabilityRepository {
  constructor(private readonly database: DatabaseService) {}

  async isEmailTaken(normalisedEmail: string): Promise<boolean> {
    const result = await this.database.db.execute<{ taken: boolean }>(
      sql`select exists(select 1 from ${users} where ${users.emailNormalized} = ${normalisedEmail}) as taken`,
    );
    return result.rows[0]?.taken === true;
  }

  async isUsernameTaken(normalisedUsername: string): Promise<boolean> {
    const result = await this.database.db.execute<{ taken: boolean }>(
      sql`select exists(select 1 from ${userProfiles} where ${userProfiles.usernameNormalized} = ${normalisedUsername}) as taken`,
    );
    return result.rows[0]?.taken === true;
  }
}
