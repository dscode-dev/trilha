import { describe, expect, it } from 'vitest';
import { PlaceStatus, isPubliclyVisible, normaliseText } from './place.js';

describe('normaliseText', () => {
  it('trims surrounding whitespace', () => {
    expect(normaliseText('  Marco Zero  ')).toBe('Marco Zero');
  });

  it('collapses internal runs of whitespace', () => {
    expect(normaliseText('Marco    Zero')).toBe('Marco Zero');
  });

  it('collapses newlines and tabs, which a paste can introduce', () => {
    expect(normaliseText('Marco\n\tZero')).toBe('Marco Zero');
  });

  it('preserves accents, which are part of the name', () => {
    expect(normaliseText('  Igreja da Sé ')).toBe('Igreja da Sé');
  });

  it('leaves an already-clean name untouched', () => {
    expect(normaliseText('Praia de Boa Viagem')).toBe('Praia de Boa Viagem');
  });

  it('reduces a whitespace-only string to empty', () => {
    expect(normaliseText('   \n  ')).toBe('');
  });
});

describe('isPubliclyVisible', () => {
  it('shows active places', () => {
    expect(isPubliclyVisible(PlaceStatus.ACTIVE)).toBe(true);
  });

  it.each([PlaceStatus.PENDING_REVIEW, PlaceStatus.ARCHIVED])('hides %s', (status) => {
    expect(isPubliclyVisible(status)).toBe(false);
  });
});
