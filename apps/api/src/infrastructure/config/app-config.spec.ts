import { loadAppConfig, loadDatabaseConfig } from './app-config.js';

/** Minimal environment that satisfies every required variable. */
const validEnv = {
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/trilha',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'PPMKe3xE1YHUiJgpEsYYPMOMy6R6zUKAPuOwUv3jS7c',
  IP_HASH_KEY: 'Yh0bJ4gGLxOaAr9OMPvBGEBWWJhBQXoflb0LBIsBnh4',
  MAPBOX_ROUTING_ACCESS_TOKEN: 'pk.test-routing-token-value-for-config-tests',
};

describe('loadAppConfig', () => {
  it('applies documented defaults when only required variables are present', () => {
    const config = loadAppConfig({ ...validEnv });

    expect(config.env).toBe('development');
    expect(config.http.port).toBe(3000);
    expect(config.http.globalPrefix).toBe('api/v1');
    expect(config.logging.level).toBe('info');
    expect(config.docs.enabled).toBe(false);
    expect(config.auth.accessTokenTtlSeconds).toBe(600);
    expect(config.auth.refreshTokenTtlSeconds).toBe(2_592_000);
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
    ['JWT_ACCESS_SECRET missing', { ...validEnv, JWT_ACCESS_SECRET: undefined }],
    ['JWT_ACCESS_SECRET too short', { ...validEnv, JWT_ACCESS_SECRET: 'short' }],
    ['IP_HASH_KEY missing', { ...validEnv, IP_HASH_KEY: undefined }],
    ['JWT_ACCESS_TTL_SECONDS beyond the hour cap', { ...validEnv, JWT_ACCESS_TTL_SECONDS: '7200' }],
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

    /* A deployment that copies .env.example unedited must fail loudly (§55). */
    it.each([
      'development-only-insecure-secret-value-replace-me',
      'change-me-change-me-change-me-change-me',
      'SECRET-secret-secret-secret-secret-secret',
    ])('refuses the placeholder access secret %p', (secret) => {
      expect(() => loadAppConfig({ ...productionEnv, JWT_ACCESS_SECRET: secret })).toThrow(
        /JWT_ACCESS_SECRET is a known placeholder/,
      );
    });

    it('refuses a placeholder IP hash key', () => {
      expect(() =>
        loadAppConfig({
          ...productionEnv,
          IP_HASH_KEY: 'development-only-insecure-secret-value-for-ip-hashing',
        }),
      ).toThrow(/IP_HASH_KEY is a known placeholder/);
    });

    it('refuses reusing the access secret as the IP hash key', () => {
      expect(() =>
        loadAppConfig({
          ...productionEnv,
          IP_HASH_KEY: productionEnv.JWT_ACCESS_SECRET,
        }),
      ).toThrow(/IP_HASH_KEY must not reuse JWT_ACCESS_SECRET/);
    });

    it('accepts distinct, non-placeholder secrets', () => {
      const config = loadAppConfig(productionEnv);
      expect(config.auth.accessTokenSecret).not.toBe(config.auth.ipHashKey);
    });
  });

  describe('loadDatabaseConfig', () => {
    it('needs only the database settings', () => {
      // A migration runner must not require a JWT signing key to do its job.
      const config = loadDatabaseConfig({
        DATABASE_URL: 'postgresql://user:pw@localhost:5432/trilha',
      });

      expect(config.url).toBe('postgresql://user:pw@localhost:5432/trilha');
      expect(config.poolMax).toBe(10);
    });

    it('still rejects a malformed DATABASE_URL', () => {
      expect(() => loadDatabaseConfig({ DATABASE_URL: 'mysql://x/y' })).toThrow(
        /Invalid environment configuration/,
      );
    });

    it('agrees with the full loader on the same input', () => {
      const env = {
        DATABASE_URL: 'postgresql://user:pw@localhost:5432/trilha',
        DATABASE_POOL_MAX: '25',
        JWT_ACCESS_SECRET: 'PPMKe3xE1YHUiJgpEsYYPMOMy6R6zUKAPuOwUv3jS7c',
        IP_HASH_KEY: 'Yh0bJ4gGLxOaAr9OMPvBGEBWWJhBQXoflb0LBIsBnh4',
        MAPBOX_ROUTING_ACCESS_TOKEN: 'pk.test-routing-token-value-for-config-tests',
        REDIS_URL: 'redis://localhost:6379',
      };

      expect(loadDatabaseConfig(env)).toEqual(loadAppConfig(env).database);
    });
  });

  describe('routing configuration (PR-03)', () => {
    const productionEnv = {
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://trilha.app',
      LOG_PRETTY: 'false',
    };

    it('applies documented routing defaults', () => {
      const config = loadAppConfig({ ...validEnv });

      expect(config.routing.timeoutMs).toBe(8_000);
      expect(config.routing.corridorDefaultMeters).toBe(5_000);
      expect(config.routing.corridorMaxMeters).toBe(20_000);
    });

    it('requires a routing token', () => {
      const { MAPBOX_ROUTING_ACCESS_TOKEN: _omitted, ...withoutToken } = validEnv;
      expect(() => loadAppConfig(withoutToken)).toThrow(/MAPBOX_ROUTING_ACCESS_TOKEN/);
    });

    it('refuses a placeholder routing token in production', () => {
      expect(() =>
        loadAppConfig({
          ...productionEnv,
          MAPBOX_ROUTING_ACCESS_TOKEN: 'development-only-insecure-secret-value-replace-me',
        }),
      ).toThrow(/MAPBOX_ROUTING_ACCESS_TOKEN is a known placeholder/);
    });

    it('refuses a default corridor wider than the maximum', () => {
      expect(() =>
        loadAppConfig({
          ...validEnv,
          ROUTING_CORRIDOR_DEFAULT_METERS: '20000',
          ROUTING_CORRIDOR_MAX_METERS: '5000',
        }),
      ).toThrow(/must not exceed/);
    });

    it('rejects an unbounded provider timeout', () => {
      expect(() => loadAppConfig({ ...validEnv, ROUTING_PROVIDER_TIMEOUT_MS: '600000' })).toThrow(
        /Invalid environment configuration/,
      );
    });
  });
});
