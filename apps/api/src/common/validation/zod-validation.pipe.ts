import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';
import { ValidationError } from '../errors/app-error.js';

/**
 * Validates and parses a request payload against a Zod schema (§30).
 *
 * Zod is already the validator for configuration; reusing it for transport keeps a
 * single validation vocabulary in the codebase instead of adding a second,
 * decorator-based one. Failures surface through the standard error envelope with
 * field-level issues, never a raw Zod dump.
 *
 *   @Body(new ZodValidationPipe(CreateThingSchema)) body: CreateThing
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new ValidationError(`Invalid ${metadata.type}`, {
      issues: formatIssues(result.error),
    });
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Flattens a ZodError into client-safe `path`/`message` pairs. */
export function formatIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
