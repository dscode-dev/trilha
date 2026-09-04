import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import { ValidationError } from '../errors/app-error.js';
import { ErrorCode } from '../errors/error-codes.js';
import type { ArgumentMetadata } from '@nestjs/common';

const bodyMetadata: ArgumentMetadata = { type: 'body' };

const schema = z.object({
  name: z.string().min(1),
  radiusMeters: z.coerce.number().int().positive(),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed value on success', () => {
    expect(pipe.transform({ name: 'Trilha', radiusMeters: '500' }, bodyMetadata)).toEqual({
      name: 'Trilha',
      radiusMeters: 500,
    });
  });

  it('strips properties the schema does not declare', () => {
    const result = pipe.transform(
      { name: 'Trilha', radiusMeters: 10, isAdmin: true },
      bodyMetadata,
    );
    expect(result).not.toHaveProperty('isAdmin');
  });

  it('raises a ValidationError carrying field-level issues', () => {
    expect.assertions(3);
    try {
      pipe.transform({ name: '', radiusMeters: -1 }, bodyMetadata);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const appError = error as ValidationError;
      expect(appError.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(appError.details?.['issues']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'name' }),
          expect.objectContaining({ path: 'radiusMeters' }),
        ]),
      );
    }
  });

  it('rejects a null payload rather than dereferencing it', () => {
    expect(() => pipe.transform(null, bodyMetadata)).toThrow(ValidationError);
  });
});
