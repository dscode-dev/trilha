import { loadAppConfig } from './app-config.js';

/** Minimal environment that satisfies every required variable. */
const validEnv = {
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/trilha',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadAppConfig', () => {
  it('applies documented defaults when only required variables are present', () => {
    const config = loadAppConfig({ ...validEnv });

    expect(config.env).toBe('development');
    expect(config.http.port).toBe(3000);
    expect(config.http.globalPrefix).toBe('api/v1');
    expect(config.logging.level).toBe('info');
    expect(config.docs.enabled).toBe(false);
  });

  it('coerces numeric and boolean strings coming from the environment', () => {
    const config = loadAppConfig({
      ...validEnv,
      APP_PORT: '8080',
      DATABASE_POOL_MAX: '25',
      SWAGGER_ENABLED: 'true',
      DATABASE_SSL: '1',
    });

    expect(config.http.port).toBe(8080);
    expect(config.database.poolMax).toBe(25);
    expect(config.docs.enabled).toBe(true);
    expect(config.database.ssl).toBe(true);
  });

  it.each([
    ['DATABASE_URL missing', {}],
    ['DATABASE_URL not a postgres URL', { ...validEnv, DATABASE_URL: 'mysql://localhost/x' }],
    ['REDIS_URL not a redis URL', { ...validEnv, REDIS_URL: 'http://localhost:6379' }],
    ['APP_PORT out of range', { ...validEnv, APP_PORT: '99999' }],
    ['NODE_ENV unknown', { ...validEnv, NODE_ENV: 'prod' }],
    ['LOG_LEVEL unknown', { ...validEnv, LOG_LEVEL: 'verbose' }],
  ])('fails fast when %s', (_name, env) => {
    expect(() => loadAppConfig(env)).toThrow(/Invalid environment configuration/);
  });

  it('names every offending variable in the error message', () => {
    expect(() => loadAppConfig({ REDIS_URL: 'nope' })).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it('parses a comma-separated CORS allow-list', () => {
    const config = loadAppConfig({
      ...validEnv,
      CORS_ORIGINS: 'https://a.example, https://b.example ',
    });

    expect(config.http.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('treats "*" as an explicit wildcard outside production', () => {
    const config = loadAppConfig({ ...validEnv, CORS_ORIGINS: '*' });
    expect(config.http.corsOrigins).toBe(true);
  });

  describe('production invariants', () => {
    const productionEnv = {
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://trilha.app',
      LOG_PRETTY: 'false',
    };

    it('accepts a correctly locked-down production configuration', () => {
      const config = loadAppConfig(productionEnv);
      expect(config.isProduction).toBe(true);
      expect(config.http.corsOrigins).toEqual(['https://trilha.app']);
    });

    it('refuses a wildcard CORS origin in production', () => {
      expect(() => loadAppConfig({ ...productionEnv, CORS_ORIGINS: '*' })).toThrow(
        /CORS_ORIGINS must enumerate explicit origins/,
      );
    });

    it('refuses pretty logging in production', () => {
      expect(() => loadAppConfig({ ...productionEnv, LOG_PRETTY: 'true' })).toThrow(
        /LOG_PRETTY must be false/,
      );
    });
  });
});
