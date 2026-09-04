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
