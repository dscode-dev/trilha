import { HttpStatus } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { ErrorCode } from '../../../common/errors/error-codes.js';

/**
 * Failures the identity domain raises deliberately.
 *
 * Each carries the client-facing code the mobile app branches on (§45), so the UI
 * never has to interpret an HTTP status to decide what to say.
 */

/**
 * Login failed.
 *
 * One error for "no such account" and for "wrong password", by design: distinguishing
 * them turns the login endpoint into an account-existence oracle (§27).
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super({
      code: ErrorCode.INVALID_CREDENTIALS,
      message: 'Email or password is incorrect',
      httpStatus: HttpStatus.UNAUTHORIZED,
    });
  }
}

/**
 * Registration conflict.
 *
 * Registration is the one place where existence is disclosed, because a signup form
 * that cannot say "this address is already registered" is unusable. The trade-off is
 * documented in ADR-0008; login discloses nothing.
 */
export class EmailAlreadyInUseError extends AppError {
  constructor() {
    super({
      code: ErrorCode.EMAIL_ALREADY_IN_USE,
      message: 'That email address is already registered',
      httpStatus: HttpStatus.CONFLICT,
    });
  }
}

export class UsernameAlreadyInUseError extends AppError {
  constructor() {
    super({
      code: ErrorCode.USERNAME_ALREADY_IN_USE,
      message: 'That username is already taken',
      httpStatus: HttpStatus.CONFLICT,
    });
  }
}

/** The access token is absent, malformed, expired, or not ours. */
export class InvalidTokenError extends AppError {
  constructor(message = 'Authentication required') {
    super({
      code: ErrorCode.INVALID_TOKEN,
      message,
      httpStatus: HttpStatus.UNAUTHORIZED,
    });
  }
}

/**
 * The session behind a refresh token is no longer usable.
 *
 * Returned for expiry, revocation, and detected reuse alike — the client's correct
 * reaction is the same in every case: discard local session state and re-authenticate.
 */
export class SessionExpiredError extends AppError {
  constructor(message = 'Your session has ended. Please sign in again.') {
    super({
      code: ErrorCode.SESSION_EXPIRED,
      message,
      httpStatus: HttpStatus.UNAUTHORIZED,
    });
  }
}

/** The account exists but may not authenticate. */
export class AccountNotActiveError extends AppError {
  constructor() {
    super({
      code: ErrorCode.ACCOUNT_DISABLED,
      message: 'This account is not available. Contact support if you think this is wrong.',
      httpStatus: HttpStatus.FORBIDDEN,
    });
  }
}
