import { z } from 'zod';

/**
 * Email as an identity key (§7).
 *
 * Normalisation here is deliberately limited to trimming and case folding. Provider
 * specific tricks — stripping Gmail dots or `+tags` — are *not* applied: they are
 * wrong for most providers and would merge addresses that genuinely differ.
 *
 * Application-side normalisation is a convenience. The actual uniqueness guarantee
 * is the generated column plus unique index in the database, which no code path can
 * bypass.
 */

/** RFC 5321 caps the whole address at 254 characters. */
export const EMAIL_MAX_LENGTH = 254;

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(EMAIL_MAX_LENGTH)
  .refine((value) => z.email().safeParse(value).success, {
    message: 'Must be a valid email address',
  });

/** Folds an address to the form used for identity comparison. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
