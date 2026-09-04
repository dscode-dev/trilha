import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { normaliseEmail } from '../domain/email.js';
import { normaliseUsername } from '../domain/username.js';
import { EmailAlreadyInUseError, UsernameAlreadyInUseError } from '../domain/identity-errors.js';
import type { DeviceContext } from '../domain/user.js';
import { PasswordHasher } from '../infrastructure/password-hasher.js';
import {
  IdentityAvailabilityRepository,
  UserRepository,
  classifyUniqueViolation,
} from '../infrastructure/user.repository.js';
import { AuthAuditRepository, AuthEventType } from '../infrastructure/auth-audit.repository.js';
import { SessionIssuer, type IssuedSession } from './session-issuer.js';

export interface RegisterInput {
  email: string;
  password: string;
  username: string;
  displayName: string;
  device: DeviceContext;
  requestId: string | null;
  ipHash: string | null;
}

export interface RegisterOutput {
  userId: string;
  session: IssuedSession;
}

/**
 * Creates an account and signs the new user in (§11).
 *
 * Registration authenticates immediately, using the same [SessionIssuer] as login so
 * there is only one session-issuing path in the system.
 */
@Injectable()
export class RegisterUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly availability: IdentityAvailabilityRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessionIssuer: SessionIssuer,
    private readonly audit: AuthAuditRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RegisterUseCase.name);
  }

  async execute(input: RegisterInput): Promise<RegisterOutput> {
    /* Stored as typed (trimmed); `email_normalized` is what carries identity, so
       there is no reason to discard the user's capitalisation. */
    const email = input.email.trim();
    const normalisedEmail = normaliseEmail(email);
    const username = input.username.trim();
    const normalisedUsername = normaliseUsername(username);

    /* Checked up front purely so the client gets a precise message. The database
       constraint below is what actually guarantees uniqueness — this check can lose a
       race, and that is expected. */
    if (await this.availability.isEmailTaken(normalisedEmail)) throw new EmailAlreadyInUseError();
    if (await this.availability.isUsernameTaken(normalisedUsername)) {
      throw new UsernameAlreadyInUseError();
    }

    const passwordHash = await this.hasher.hash(input.password);

    let userId: string;
    try {
      ({ userId } = await this.users.createAccount({
        email,
        passwordHash,
        username,
        displayName: input.displayName.trim(),
      }));
    } catch (error) {
      /* Two concurrent signups both passed the availability check; the database
         rejected the loser. Translate rather than surfacing a 500. */
      const violated = classifyUniqueViolation(error);
      if (violated === 'EMAIL') throw new EmailAlreadyInUseError();
      if (violated === 'USERNAME') throw new UsernameAlreadyInUseError();
      throw error;
    }

    const now = new Date();
    const session = await this.sessionIssuer.issue(userId, input.device, now);

    await this.audit.record({
      eventType: AuthEventType.REGISTER_SUCCEEDED,
      userId,
      sessionId: session.sessionId,
      requestId: input.requestId,
      ipHash: input.ipHash,
    });

    this.logger.info({ event: 'auth.register.succeeded', userId }, 'Account registered');

    return { userId, session };
  }
}
