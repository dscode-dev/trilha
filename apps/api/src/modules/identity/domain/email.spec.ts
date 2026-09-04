import { describe, expect, it } from 'vitest';
import { emailSchema, normaliseEmail } from './email.js';

describe('normaliseEmail', () => {
  it.each([
    ['Foo@Example.com', 'foo@example.com'],
    ['  ana@trilha.app  ', 'ana@trilha.app'],
    ['ANA@TRILHA.APP', 'ana@trilha.app'],
  ])('folds %p to %p', (input, expected) => {
    expect(normaliseEmail(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = normaliseEmail('Foo@Example.com');
    expect(normaliseEmail(once)).toBe(once);
  });

  it('treats case variants of one address as one identity', () => {
    expect(normaliseEmail('Foo@Example.com')).toBe(normaliseEmail('foo@EXAMPLE.com'));
  });

  it('does not strip dots or plus tags', () => {
    // Those are provider-specific conventions; folding them would merge addresses
    // that genuinely differ on most mail hosts.
    expect(normaliseEmail('a.b+tag@example.com')).toBe('a.b+tag@example.com');
  });
});

describe('emailSchema', () => {
  it.each(['ana@trilha.app', 'a.b+tag@example.co.uk', 'x@y.io'])('accepts %p', (value) => {
    expect(emailSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['no at sign', 'anatrilha.app'],
    ['no domain', 'ana@'],
    ['no local part', '@trilha.app'],
    ['empty', ''],
    ['spaces inside', 'a b@trilha.app'],
  ])('rejects %s', (_name, value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });

  it('rejects an address beyond the RFC 5321 length limit', () => {
    const tooLong = `${'a'.repeat(250)}@trilha.app`;
    expect(emailSchema.safeParse(tooLong).success).toBe(false);
  });

  it('trims before validating', () => {
    const parsed = emailSchema.safeParse('  ana@trilha.app ');
    expect(parsed.success && parsed.data).toBe('ana@trilha.app');
  });
});
