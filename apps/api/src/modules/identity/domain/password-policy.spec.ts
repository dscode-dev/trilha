import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isTrivialPassword,
  passwordSchema,
} from './password-policy.js';

describe('passwordSchema', () => {
  it('accepts a passphrase', () => {
    expect(passwordSchema.safeParse('a quiet trail through pine').success).toBe(true);
  });

  it('accepts a long random string', () => {
    expect(passwordSchema.safeParse('Xk92mVq7Lz03pRt5').success).toBe(true);
  });

  it('does not demand mixed case, digits or symbols', () => {
    // NIST SP 800-63B withdrew composition rules; length is what we ask for.
    expect(passwordSchema.safeParse('correcthorsebatterystaple').success).toBe(true);
  });

  it(`rejects anything shorter than ${String(PASSWORD_MIN_LENGTH)} characters`, () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(passwordSchema.safeParse('short').success).toBe(false);
  });

  it('accepts exactly the minimum length', () => {
    expect(passwordSchema.safeParse('abcdefghijkm').success).toBe(true);
  });

  it(`rejects anything longer than ${String(PASSWORD_MAX_LENGTH)} characters`, () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('never silently truncates a password at the maximum length', () => {
    const value = 'trilha-passphrase-'.repeat(8).slice(0, PASSWORD_MAX_LENGTH);
    const parsed = passwordSchema.safeParse(value);

    expect(value).toHaveLength(PASSWORD_MAX_LENGTH);
    expect(parsed.success && parsed.data).toBe(value);
  });

  it.each(['password123', 'PASSWORD123', 'Passw0rd'])('rejects the common value %p', (value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a long string with too few distinct characters', () => {
    expect(passwordSchema.safeParse('aaaaaaaaaaaaaaaa').success).toBe(false);
    expect(passwordSchema.safeParse('ababababababab').success).toBe(false);
  });

  it('preserves leading and trailing spaces inside a passphrase', () => {
    // Trimming a password would silently change the secret the user chose.
    const value = ' a quiet trail through pine ';
    const parsed = passwordSchema.safeParse(value);
    expect(parsed.success && parsed.data).toBe(value);
  });
});

describe('isTrivialPassword', () => {
  it('is case-insensitive', () => {
    expect(isTrivialPassword('PaSsWoRd123')).toBe(true);
  });

  it('does not flag a real passphrase', () => {
    expect(isTrivialPassword('a quiet trail through pine')).toBe(false);
  });
});
