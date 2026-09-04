import { z } from 'zod';

/**
 * Single source of truth for every environment variable the API reads.
 *
 * Constitution §Engineering: configuration is validated once, at startup, and the
 * process refuses to boot when it is invalid (fail fast). No `process.env` access
 * is permitted anywhere else in the codebase.
 */

export const NODE_ENVIRONMENTS = ['development', 'staging', 'production', 'test'] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Coerces the common string spellings of a boolean coming from a shell/env file. */
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const port = z.coerce.number().int().min(1).max(65_535);

/**
 * A 256-bit key encoded as hex or base64 lands comfortably above this. The floor
 * exists to reject a secret someone typed by hand.
 */
export const JWT_SECRET_MIN_LENGTH = 32;

/**
 * Placeholder values that must never reach a deployed environment. The `.env.example`
 * ships with these precisely so that copying it without editing fails loudly (§55).
 */
export const INSECURE_SECRETS: readonly string[] = [
  'change-me',
  'changeme',
  'secret',
  'development-only-insecure-secret-value',
  'replace-this-with-a-real-secret-value',
];

export const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),

  APP_HOST: z.string().min(1).default('0.0.0.0'),
  APP_PORT: port.default(3000),
  APP_NAME: z.string().min(1).default('trilha-api'),

  /** Comma-separated list of allowed origins, or `*` in development only. */
  CORS_ORIGINS: z.string().default(''),
  /** Maximum accepted request body size, in a format `body-parser` understands. */
  HTTP_BODY_LIMIT: z.string().default('1mb'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
  DATABASE_SSL: booleanFromEnv(false),

  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).default(2_000),

  /* --- Authentication (PR-01) --------------------------------------------- */
  /**
   * HMAC key for access tokens. Never generated at boot: a per-instance secret would
   * invalidate every token on restart and break horizontal scaling (§55).
   */
  JWT_ACCESS_SECRET: z.string().min(JWT_SECRET_MIN_LENGTH),
  JWT_ISSUER: z.string().min(1).default('trilha-api'),
  JWT_AUDIENCE: z.string().min(1).default('trilha-mobile'),

  /** Access token lifetime. Short by design — revocation relies on it expiring (§13). */
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),

  /** Refresh token and session lifetime. */
  REFRESH_TTL_SECONDS: z.coerce.number().int().min(3_600).max(31_536_000).default(2_592_000),

  /** Key for the keyed digest of client IPs in audit records (§18). */
  IP_HASH_KEY: z.string().min(JWT_SECRET_MIN_LENGTH),

  /* --- Authentication rate limits (§26) ------------------------------------ */
  RATE_LIMIT_LOGIN_PER_IP: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_LOGIN_PER_ACCOUNT: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_REGISTER_PER_IP: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_REFRESH_PER_IP: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_PASSWORD_PER_USER: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3_600).default(900),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Human-readable log output. Intended for local development only. */
  LOG_PRETTY: booleanFromEnv(false),

  /** Serves the OpenAPI UI. Disabled by default outside development. */
  SWAGGER_ENABLED: booleanFromEnv(false),
  SWAGGER_PATH: z.string().min(1).default('docs'),

  SENTRY_DSN: z.url().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;
