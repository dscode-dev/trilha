import { z } from 'zod';

/**
 * Password policy (§10).
 *
 * Length is the requirement that actually correlates with strength, so this policy
 * asks for length and gets out of the way. There is deliberately no
 * "one uppercase, one digit, one symbol" rule: NIST SP 800-63B withdrew that guidance
 * because it pushes people toward `Password1!` and away from passphrases.
 *
 * What is enforced:
 *   - a floor long enough to make offline guessing expensive alongside Argon2id;
 *   - a ceiling, because an unbounded password is an unbounded amount of hashing work
 *     accepted from an unauthenticated caller;
 *   - rejection of a handful of trivially guessable values.
 *
 * Nothing is silently truncated — an over-long password is an error, never a prefix.
 */

export const PASSWORD_MIN_LENGTH = 12;

/**
 * Argon2id itself has no practical input limit, but accepting megabyte passwords
 * would let anyone burn CPU at will. 128 characters comfortably fits a passphrase.
 */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Values common enough that an attacker tries them first. This is a guard rail, not a
 * breach corpus: real breach lookup needs an external service, which §10 excludes from
 * this PR.
 */
const TRIVIAL_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '123456789012',
  '1234567890123',
  'qwertyuiop12',
  'letmein12345',
  'iloveyou1234',
  'administrator',
  'trilha123456',
]);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, {
    message: `Use at least ${String(PASSWORD_MIN_LENGTH)} characters. A short sentence works well.`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    message: `Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`,
  })
  .refine((value) => !TRIVIAL_PASSWORDS.has(value.toLowerCase()), {
    message: 'That password is too easy to guess. Choose something less common.',
  })
  .refine((value) => new Set(value).size > 3, {
    message: 'That password repeats too few distinct characters.',
  });

export function isTrivialPassword(password: string): boolean {
  return TRIVIAL_PASSWORDS.has(password.toLowerCase());
}
