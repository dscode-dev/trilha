import { parseHeaders } from './tracing.js';

describe('parseHeaders', () => {
  it('parses the W3C key=value,key=value form', () => {
    expect(parseHeaders('authorization=Bearer abc,x-tenant=trilha')).toEqual({
      authorization: 'Bearer abc',
      'x-tenant': 'trilha',
    });
  });

  it('trims whitespace around keys and values', () => {
    expect(parseHeaders(' a = 1 , b = 2 ')).toEqual({ a: '1', b: '2' });
  });

  it('preserves "=" inside a value', () => {
    expect(parseHeaders('token=abc=def==')).toEqual({ token: 'abc=def==' });
  });

  it.each(['', 'novalue', '=orphan', ','])('ignores the malformed input %p', (input) => {
    expect(parseHeaders(input)).toEqual({});
  });
});
