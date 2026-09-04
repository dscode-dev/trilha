import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { normaliseEmail } from '../domain/email.js';
import { AccountNotActiveError, InvalidCredentialsError } from '../domain/identity-errors.js';
import { canAuthenticate, type DeviceContext } from '../domain/user.js';
import { PasswordHasher } from '../infrastructure/password-hasher.js';
import { getDummyHash } from '../infrastructure/dummy-hash.js';
import { UserRepository } from '../infrastructure/user.repository.js';
import { AuthAuditRepository, AuthEventType } from '../infrastructure/auth-audit.repository.js';
import { SessionIssuer, type IssuedSession } from './session-issuer.js';

export interface LoginInput {
  email: string;
  password: string;
  device: DeviceContext;
  requestId: string | null;
  ipHash: string | null;
}

export interface LoginOutput {
  userId: string;
  session: IssuedSession;
}

/**
 * Authenticates an existing account (§12).
 *
 * Two properties matter as much as the happy path:
 *
 * **Identical failures.** Unknown address and wrong password both raise
 * `InvalidCredentialsError`. The endpoint must not become a way to enumerate
 * registered addresses (§27).
 *
 * **Comparable timing.** When no account matches, a verification still runs against a
 * pre-computed dummy hash. Otherwise "unknown address" would return in microseconds
 * against ~90 ms for a real comparison, and that gap is itself the oracle the
 * identical message was meant to close.
 */
@Injectable()
export class LoginUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessionIssuer: SessionIssuer,
    private readonly audit: AuthAuditRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LoginUseCase.name);
  }

  async execute(input: LoginInput): Promise<LoginOutput> {
    const email = normaliseEmail(input.email);
    const record = await this.users.findForAuthentication(email);

    const passwordMatches = await this.hasher.verify(
      record?.passwordHash ?? (await getDummyHash()),
      input.password,
    );

    if (record === undefined || !passwordMatches) {
      await this.audit.record({
        eventType: AuthEventType.LOGIN_FAILED,
        /* Attributed when the account exists, so support can see failed attempts on a
           real account; null otherwise, because there is nothing to attribute to. */
        userId: record?.userId ?? null,
        requestId: input.requestId,
        ipHash: input.ipHash,
        metadata: { reason: record === undefined ? 'UNKNOWN_ACCOUNT' : 'BAD_PASSWORD' },
      });

      /* The log may distinguish the cases; the response never does. */
      this.logger.info(
        { event: 'auth.login.failed', accountExists: record !== undefined },
        'Login failed',
      );

      throw new InvalidCredentialsError();
    }

    if (!canAuthenticate(record.status)) {
      await this.audit.record({
        eventType: AuthEventType.LOGIN_FAILED,
        userId: record.userId,
        requestId: input.requestId,
        ipHash: input.ipHash,
        metadata: { reason: 'ACCOUNT_NOT_ACTIVE', status: record.status },
      });
      throw new AccountNotActiveError();
    }

    const session = await this.sessionIssuer.issue(record.userId, input.device, new Date());

    await this.audit.record({
      eventType: AuthEventType.LOGIN_SUCCEEDED,
      userId: record.userId,
      sessionId: session.sessionId,
      requestId: input.requestId,
      ipHash: input.ipHash,
    });

    this.logger.info({ event: 'auth.login.succeeded', userId: record.userId }, 'Login succeeded');

    return { userId: record.userId, session };
  }
}
