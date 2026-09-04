import { normaliseInboundRequestId } from './request-id.middleware.js';

describe('normaliseInboundRequestId', () => {
  it('accepts a well-formed inbound correlation id', () => {
    expect(normaliseInboundRequestId('018f4c9e-2a1b-7c3d-9e4f-5a6b7c8d9e0f')).toBe(
      '018f4c9e-2a1b-7c3d-9e4f-5a6b7c8d9e0f',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseInboundRequestId('  abc-123  ')).toBe('abc-123');
  });

  it('takes the first value when the header is repeated', () => {
    expect(normaliseInboundRequestId(['first-id', 'second-id'])).toBe('first-id');
  });

  /* A correlation id is echoed into logs and response headers, so anything that
     could forge a log line or split a header must be replaced, not passed through. */
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['too long', 'a'.repeat(129)],
    ['containing a newline (log injection)', 'abc\ninjected'],
    ['containing a carriage return (header splitting)', 'abc\r\nSet-Cookie: x=1'],
    ['containing a space', 'abc def'],
    ['containing markup', '<script>alert(1)</script>'],
    ['containing a null byte', 'abc\u0000def'],
  ])('rejects a request id that is %s', (_name, input) => {
    expect(normaliseInboundRequestId(input)).toBeUndefined();
  });

  it('accepts the maximum permitted length', () => {
    const id = 'a'.repeat(128);
    expect(normaliseInboundRequestId(id)).toBe(id);
  });
});
