import { sanitiseReason } from './readiness.service.js';

describe('sanitiseReason', () => {
  it('redacts a credentialed PostgreSQL URL', () => {
    const reason = sanitiseReason(
      new Error('connect ECONNREFUSED postgresql://trilha:s3cret@db.internal:5432/trilha'),
    );

    expect(reason).not.toContain('s3cret');
    expect(reason).not.toContain('db.internal');
    expect(reason).toContain('[redacted-url]');
  });

  it('redacts a Redis URL', () => {
    expect(sanitiseReason(new Error('redis://user:pw@cache:6379 unreachable'))).not.toContain(
      'pw@',
    );
  });

  it('keeps a message that contains no URL or SQL readable for operators', () => {
    expect(sanitiseReason(new Error('Redis PING timed out'))).toBe('Redis PING timed out');
  });

  describe('SQL redaction (§11: never leak SQL to clients)', () => {
    it('strips the failing statement appended by the driver', () => {
      const reason = sanitiseReason(new Error('Failed query: select 1\nparams: '));

      expect(reason).not.toMatch(/select/i);
      expect(reason).toContain('[redacted-query]');
    });

    it('strips a statement that names real tables', () => {
      const reason = sanitiseReason(
        new Error('error: SELECT id, email FROM users WHERE token = $1'),
      );

      expect(reason).not.toMatch(/users/i);
      expect(reason).not.toMatch(/email/i);
    });

    it.each(['INSERT INTO', 'UPDATE', 'DELETE FROM', 'DROP TABLE', 'ALTER TABLE'])(
      'strips a %s statement',
      (statement) => {
        const reason = sanitiseReason(new Error(`boom ${statement} secrets`));
        expect(reason).not.toMatch(/secrets/i);
      },
    );

    it('redacts a DSN and a statement in the same message', () => {
      const reason = sanitiseReason(
        new Error('connect postgresql://u:pw@host:5432/db failed running select 1'),
      );

      expect(reason).not.toContain('pw@');
      expect(reason).not.toMatch(/select/i);
    });
  });

  it('caps the length so a probe cannot flood the response', () => {
    expect(sanitiseReason(new Error('x'.repeat(500))).length).toBe(200);
  });

  it('describes a non-Error throwable without crashing', () => {
    expect(sanitiseReason({ weird: true })).toBe('Unknown error');
  });
});
