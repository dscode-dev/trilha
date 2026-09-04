import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { normaliseUsername } from '../domain/username.js';
import { UsernameAlreadyInUseError } from '../domain/identity-errors.js';
import { NotFoundError } from '../../../common/errors/app-error.js';
import {
  IdentityAvailabilityRepository,
  UserRepository,
  classifyUniqueViolation,
  type UserWithProfile,
} from '../infrastructure/user.repository.js';
import { AuthAuditRepository, AuthEventType } from '../infrastructure/auth-audit.repository.js';

export interface UpdateProfileInput {
  userId: string;
  username?: string | undefined;
  displayName?: string | undefined;
  bio?: string | null | undefined;
  requestId: string | null;
}

/**
 * Reads and edits the public profile (§22, §23).
 *
 * Only the three V1 fields are writable. `avatarUrl` is deliberately not settable:
 * there is no object storage yet, and an endpoint that accepted an arbitrary URL
 * would be both a mock and an SSRF-shaped hazard.
 */
@Injectable()
export class ProfileUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly availability: IdentityAvailabilityRepository,
    private readonly audit: AuthAuditRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProfileUseCase.name);
  }

  async getByUserId(userId: string): Promise<UserWithProfile> {
    const profile = await this.users.findWithProfile(userId);
    if (profile === undefined) {
      /* The token verified but the account is gone — deleted mid-session. */
      throw new NotFoundError('Account not found');
    }
    return profile;
  }

  async update(input: UpdateProfileInput): Promise<UserWithProfile> {
    const changes: { username?: string; displayName?: string; bio?: string | null } = {};

    if (input.username !== undefined) {
      const username = input.username.trim();
      const current = await this.getByUserId(input.userId);

      /* Re-submitting the same name must not collide with the user's own record. */
      if (normaliseUsername(username) !== normaliseUsername(current.username)) {
        if (await this.availability.isUsernameTaken(normaliseUsername(username))) {
          throw new UsernameAlreadyInUseError();
        }
      }
      changes.username = username;
    }

    if (input.displayName !== undefined) changes.displayName = input.displayName.trim();
    if (input.bio !== undefined) changes.bio = input.bio === null ? null : input.bio.trim();

    if (Object.keys(changes).length > 0) {
      try {
        await this.users.updateProfile(input.userId, changes);
      } catch (error) {
        if (classifyUniqueViolation(error) === 'USERNAME') throw new UsernameAlreadyInUseError();
        throw error;
      }

      await this.audit.record({
        eventType: AuthEventType.PROFILE_UPDATED,
        userId: input.userId,
        requestId: input.requestId,
        /* Field names only — never the values, which are user content. */
        metadata: { fields: Object.keys(changes) },
      });

      this.logger.info(
        { event: 'profile.updated', userId: input.userId, fields: Object.keys(changes) },
        'Profile updated',
      );
    }

    return this.getByUserId(input.userId);
  }
}
