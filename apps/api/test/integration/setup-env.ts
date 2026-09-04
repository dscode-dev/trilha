/**
 * Environment for the integration suite.
 *
 * Defaults match infra/local/docker-compose.yml; CI overrides them via real env
 * vars. Nothing here is a mock — these point at genuine services.
 */
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??= 'postgresql://trilha:trilha@localhost:5432/trilha';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['LOG_LEVEL'] = 'fatal';
process.env['LOG_PRETTY'] = 'false';
process.env['SWAGGER_ENABLED'] = 'false';
process.env['CORS_ORIGINS'] = 'http://localhost';

/* Test-only secrets. Distinct from each other, and long enough to satisfy the
   schema; they never leave this process. */
process.env['JWT_ACCESS_SECRET'] = 'test-only-access-secret-4f8a1c9e2b7d4f3a9c8e1d5b7a3f0e62';
process.env['IP_HASH_KEY'] = 'test-only-ip-hash-key-6d2b8e4a1f7c3950ab8d2e6f4c1a7b3d';
process.env['JWT_ISSUER'] = 'trilha-api';
process.env['JWT_AUDIENCE'] = 'trilha-mobile';
process.env['JWT_ACCESS_TTL_SECONDS'] = '600';
process.env['REFRESH_TTL_SECONDS'] = '2592000';

/* Ceilings high enough that functional tests are not throttled; the rate-limit
   suite lowers them deliberately for the cases that need it. */
process.env['RATE_LIMIT_WINDOW_SECONDS'] = '900';
process.env['RATE_LIMIT_LOGIN_PER_IP'] = '10000';
process.env['RATE_LIMIT_LOGIN_PER_ACCOUNT'] = '10000';
process.env['RATE_LIMIT_REGISTER_PER_IP'] = '10000';
process.env['RATE_LIMIT_REFRESH_PER_IP'] = '10000';
