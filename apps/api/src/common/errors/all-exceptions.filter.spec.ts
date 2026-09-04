import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { extractTransportStatus, mapException } from './all-exceptions.filter.js';
import { AppError, DependencyUnavailableError, ValidationError } from './app-error.js';
import { ErrorCode } from './error-codes.js';

describe('mapException', () => {
  it('preserves code, status and details from an AppError', () => {
    const error = new ValidationError('Bad payload', { issues: [{ path: 'name' }] });
    const mapped = mapException(error);

    expect(mapped.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(mapped.httpStatus).toBe(HttpStatus.BAD_REQUEST);
    expect(mapped.message).toBe('Bad payload');
    expect(mapped.details).toEqual({ issues: [{ path: 'name' }] });
  });

  it('maps a dependency outage to 503', () => {
    const mapped = mapException(new DependencyUnavailableError('postgres'));

    expect(mapped.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    expect(mapped.httpStatus).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(mapped.details).toEqual({ dependency: 'postgres' });
  });

  it.each([
    [new NotFoundException(), HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND],
    [new BadRequestException(), HttpStatus.BAD_REQUEST, ErrorCode.BAD_REQUEST],
    [new HttpException('teapot', 418), 418, ErrorCode.BAD_REQUEST],
  ])('translates framework exception %#', (exception, status, code) => {
    const mapped = mapException(exception);
    expect(mapped.httpStatus).toBe(status);
    expect(mapped.code).toBe(code);
  });

  it('surfaces array-style validation messages as structured issues', () => {
    const mapped = mapException(new BadRequestException(['name must be a string']));

    expect(mapped.code).toBe(ErrorCode.BAD_REQUEST);
    expect(mapped.details).toEqual({ issues: ['name must be a string'] });
  });

  describe('information leakage', () => {
    it('masks the message of an unknown throwable', () => {
      const mapped = mapException(new Error('connect ECONNREFUSED 10.0.0.4:5432'));

      expect(mapped.httpStatus).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(mapped.message).toBe('An unexpected error occurred');
      expect(mapped.message).not.toContain('10.0.0.4');
      /* The real cause must still reach the server-side log. */
      expect(mapped.logMessage).toContain('ECONNREFUSED');
    });

    it('never exposes SQL through the client-facing message', () => {
      const error = new Error('syntax error at or near "SELECT * FROM users"');
      const mapped = mapException(error);

      expect(mapped.message).not.toMatch(/SELECT/i);
      expect(JSON.stringify(mapped.details ?? {})).not.toMatch(/SELECT/i);
    });

    it('masks a 5xx HttpException message', () => {
      const mapped = mapException(
        new HttpException('db password is hunter2', HttpStatus.INTERNAL_SERVER_ERROR),
      );

      expect(mapped.message).toBe('An unexpected error occurred');
      expect(mapped.message).not.toContain('hunter2');
    });

    it('handles a non-Error throwable without crashing', () => {
      const mapped = mapException('a bare string');

      expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(mapped.httpStatus).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mapped.logMessage).toBe('Non-Error exception thrown');
    });
  });

  describe('Express-convention middleware errors', () => {
    /* body-parser and CORS throw plain Errors carrying a numeric `status`. */
    it('maps an oversized body to 413 rather than 500', () => {
      const error = Object.assign(new Error('request entity too large'), {
        status: 413,
        type: 'entity.too.large',
      });
      const mapped = mapException(error);

      expect(mapped.httpStatus).toBe(413);
      expect(mapped.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
      expect(mapped.message).toBe('request entity too large');
    });

    it('honours the statusCode spelling too', () => {
      const mapped = mapException(Object.assign(new Error('bad json'), { statusCode: 400 }));
      expect(mapped.httpStatus).toBe(400);
    });

    it('still masks a 5xx carried on a middleware error', () => {
      const mapped = mapException(Object.assign(new Error('upstream blew up'), { status: 502 }));

      expect(mapped.httpStatus).toBe(502);
      expect(mapped.message).toBe('An unexpected error occurred');
    });

    it('truncates an unbounded middleware message', () => {
      const mapped = mapException(Object.assign(new Error('x'.repeat(500)), { status: 400 }));
      expect(mapped.message.length).toBeLessThanOrEqual(201);
    });
  });

  describe('extractTransportStatus', () => {
    it.each([
      ['status', { status: 413 }, 413],
      ['statusCode', { statusCode: 400 }, 400],
    ])('reads a numeric %s', (_name, input, expected) => {
      expect(extractTransportStatus(input)).toBe(expected);
    });

    it.each([
      ['a non-HTTP number', { status: 42 }],
      ['a string status', { status: '413' }],
      ['a non-integer', { status: 413.5 }],
      ['no status at all', { message: 'nope' }],
      ['a primitive', 'oops'],
      ['null', null],
    ])('ignores %s', (_name, input) => {
      expect(extractTransportStatus(input)).toBeUndefined();
    });
  });

  it('keeps a custom AppError subclass message intact for 4xx', () => {
    class TeapotError extends AppError {
      constructor() {
        super({ code: ErrorCode.CONFLICT, message: 'Already brewed', httpStatus: 409 });
      }
    }
    const mapped = mapException(new TeapotError());
    expect(mapped.message).toBe('Already brewed');
    expect(mapped.code).toBe(ErrorCode.CONFLICT);
  });
});
