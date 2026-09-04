import type { z } from 'zod';
import { envSchema, type Env, type NodeEnvironment } from './env.schema.js';

/**
 * Structured, immutable view over validated environment variables.
 *
 * Application code injects `AppConfig` and reads a typed group; it never touches
 * `process.env`. Grouping keeps call sites honest about what they actually depend on.
 */

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  readonly globalPrefix: string;
  readonly corsOrigins: readonly string[] | true;
  readonly bodyLimit: string;
}

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly ssl: boolean;
}

export interface RedisConfig {
  readonly url: string;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
}

export interface LoggingConfig {
  readonly level: Env['LOG_LEVEL'];
  readonly pretty: boolean;
}

export interface DocsConfig {
  readonly enabled: boolean;
  readonly path: string;
}

export interface ObservabilityConfig {
  readonly sentryDsn: string | undefined;
  readonly sentryTracesSampleRate: number;
  readonly otlpEndpoint: string | undefined;
  readonly otlpHeaders: string | undefined;
  readonly serviceName: string;
}

export class AppConfig {
  readonly env: NodeEnvironment;
  readonly serviceName: string;
  readonly http: HttpConfig;
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
  readonly logging: LoggingConfig;
  readonly docs: DocsConfig;
  readonly observability: ObservabilityConfig;

  constructor(env: Env) {
    this.env = env.NODE_ENV;
    this.serviceName = env.APP_NAME;

    this.http = {
      host: env.APP_HOST,
      port: env.APP_PORT,
      globalPrefix: 'api/v1',
      corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
      bodyLimit: env.HTTP_BODY_LIMIT,
    };

    this.database = {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      ssl: env.DATABASE_SSL,
    };

    this.redis = {
      url: env.REDIS_URL,
      connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
      commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
    };

    this.logging = { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY };
    this.docs = { enabled: env.SWAGGER_ENABLED, path: env.SWAGGER_PATH };

    this.observability = {
      sentryDsn: env.SENTRY_DSN,
      sentryTracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
      otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      otlpHeaders: env.OTEL_EXPORTER_OTLP_HEADERS,
      serviceName: env.OTEL_SERVICE_NAME ?? env.APP_NAME,
    };
  }

  get isProduction(): boolean {
    return this.env === 'production';
  }

  get isDevelopment(): boolean {
    return this.env === 'development';
  }
}

/** `*` is accepted only as an explicit developer opt-in; production must enumerate origins. */
function parseCorsOrigins(raw: string): readonly string[] | true {
  const trimmed = raw.trim();
  if (trimmed === '*') return true;
  return trimmed
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Validates raw environment input and builds the typed configuration.
 * Throws with an aggregated, human-readable report so a bad deploy fails loudly.
 */
export function loadAppConfig(source: Record<string, unknown>): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new Error(formatConfigError(result.error));
  }

  const config = new AppConfig(result.data);
  assertProductionInvariants(config);
  return config;
}

function formatConfigError(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  return `Invalid environment configuration:\n${issues}`;
}

/** Guards that are only errors in production, where a permissive default is a defect. */
function assertProductionInvariants(config: AppConfig): void {
  if (!config.isProduction) return;

  const violations: string[] = [];
  if (config.http.corsOrigins === true) {
    violations.push('CORS_ORIGINS must enumerate explicit origins in production (got "*")');
  }
  if (config.logging.pretty) {
    violations.push('LOG_PRETTY must be false in production (structured JSON logs are required)');
  }

  if (violations.length > 0) {
    throw new Error(
      `Invalid production configuration:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }
}
