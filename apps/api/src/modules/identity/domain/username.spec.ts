import { describe, expect, it } from 'vitest';
import { isReservedUsername, normaliseUsername, usernameSchema } from './username.js';

describe('usernameSchema', () => {
  it.each(['ana', 'ana-souza', 'ana_souza', 'trilha2026', 'a1b2c3'])('accepts %p', (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(31)],
    ['leading hyphen', '-ana'],
    ['trailing underscore', 'ana_'],
    ['double separator', 'ana--souza'],
    ['contains a dot', 'ana.souza'],
    ['contains a slash', 'ana/souza'],
    ['contains a space', 'ana souza'],
    ['non-ASCII', 'anaç'],
    ['emoji', 'ana🌲'],
    ['empty', ''],
  ])('rejects one that is %s', (_name, value) => {
    expect(usernameSchema.safeParse(value).success).toBe(false);
  });

  it('accepts mixed case and preserves it for display', () => {
    const parsed = usernameSchema.safeParse('Ana-Souza');
    expect(parsed.success && parsed.data).toBe('Ana-Souza');
  });

  it.each(['admin', 'ADMIN', 'me', 'api', 'settings', 'trilha'])('reserves %p', (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(false);
    expect(isReservedUsername(value)).toBe(true);
  });

  it('rejects names that would break a future profile URL', () => {
    // Path separators and extension-looking names must never reach /u/<username>.
    for (const value of ['ana/../admin', 'ana.json', 'a/b']) {
      expect(usernameSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('normaliseUsername', () => {
  it('folds case and trims', () => {
    expect(normaliseUsername('  Ana-Souza ')).toBe('ana-souza');
  });

  it('maps case variants onto one key', () => {
    expect(normaliseUsername('AnaSouza')).toBe(normaliseUsername('anasouza'));
  });
});
