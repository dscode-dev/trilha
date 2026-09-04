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
