import { z } from 'zod';

/**
 * Username rules (§8).
 *
 * A username is reserved for future public exposure — profile URLs, mentions — so the
 * character set is restricted now, while the cost of doing so is zero. Widening a
 * character set later is easy; narrowing it after people have chosen names is not.
 *
 * Excluded on purpose:
 *   - `.` and `/`, which would collide with path and file-extension parsing;
 *   - leading/trailing separators and runs of them, which make near-identical names;
 *   - anything non-ASCII, which invites homograph impersonation.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

/** Lowercase alphanumerics with single internal `_` or `-` separators. */
const USERNAME_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/**
 * Names the platform must keep, so nobody can claim a URL that will later mean
 * something else. Compared against the normalised form.
 */
const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'api',
  'app',
  'auth',
  'help',
  'login',
  'logout',
  'me',
  'moderator',
  'null',
  'privacy',
  'register',
  'root',
  'settings',
  'signin',
  'signup',
  'support',
  'system',
  'terms',
  'trilha',
  'undefined',
  'user',
  'users',
]);

export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH)
  .max(USERNAME_MAX_LENGTH)
  .refine((value) => USERNAME_PATTERN.test(normaliseUsername(value)), {
    message: 'Use letters and numbers, optionally separated by a single hyphen or underscore',
  })
  .refine((value) => !RESERVED_USERNAMES.has(normaliseUsername(value)), {
    message: 'That username is reserved',
  });

export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(normaliseUsername(username));
}
