import type { z } from 'zod';
import { INSECURE_SECRETS, envSchema, type Env, type NodeEnvironment } from './env.schema.js';

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

export interface AuthConfig {
  readonly accessTokenSecret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly ipHashKey: string;
}

/** Per-window ceilings for the authentication endpoints (§26). */
export interface RateLimitConfig {
  readonly windowSeconds: number;
  readonly loginPerIp: number;
  readonly loginPerAccount: number;
  readonly registerPerIp: number;
  readonly refreshPerIp: number;
  readonly passwordPerUser: number;
  readonly routingPerUser: number;
  readonly routingPerIp: number;
  /** Discovery is metered separately, on a longer window (§42). */
  readonly discoveryWindowSeconds: number;
  readonly discoveryPerUser: number;
  readonly discoveryPerIp: number;
}

/**
 * Operational ceilings for discovery (§84).
 *
 * Only the *bounds* live here. The relevance weights deliberately do not: a score is
 * a versioned product decision that must be reproducible from a policy name, and
 * weights read from the environment would make two deployments rank the same route
 * differently with nothing in the response to explain it (§37).
 */
export interface DiscoveryConfig {
  readonly maxSpatialCandidates: number;
  readonly maxDetourCandidates: number;
  readonly providerConcurrency: number;
  readonly defaultMaxDetourMinutes: number;
  readonly maxDetourMinutes: number;
  readonly maxResults: number;
}

export interface RoutingConfig {
  readonly accessToken: string;
  readonly timeoutMs: number;
  readonly corridorDefaultMeters: number;
  readonly corridorMaxMeters: number;
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
  readonly auth: AuthConfig;
  readonly rateLimit: RateLimitConfig;
  readonly routing: RoutingConfig;
  readonly discovery: DiscoveryConfig;
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

    this.auth = {
      accessTokenSecret: env.JWT_ACCESS_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTokenTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTokenTtlSeconds: env.REFRESH_TTL_SECONDS,
      ipHashKey: env.IP_HASH_KEY,
    };

    this.routing = {
      accessToken: env.MAPBOX_ROUTING_ACCESS_TOKEN,
      timeoutMs: env.ROUTING_PROVIDER_TIMEOUT_MS,
      corridorDefaultMeters: env.ROUTING_CORRIDOR_DEFAULT_METERS,
      corridorMaxMeters: env.ROUTING_CORRIDOR_MAX_METERS,
    };

    this.discovery = {
      maxSpatialCandidates: env.DISCOVERY_MAX_SPATIAL_CANDIDATES,
      maxDetourCandidates: env.DISCOVERY_MAX_DETOUR_CANDIDATES,
      providerConcurrency: env.DISCOVERY_PROVIDER_CONCURRENCY,
      defaultMaxDetourMinutes: env.DISCOVERY_DEFAULT_MAX_DETOUR_MINUTES,
      maxDetourMinutes: env.DISCOVERY_MAX_DETOUR_MINUTES,
      maxResults: env.DISCOVERY_MAX_RESULTS,
    };

    this.rateLimit = {
      windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
      loginPerIp: env.RATE_LIMIT_LOGIN_PER_IP,
      loginPerAccount: env.RATE_LIMIT_LOGIN_PER_ACCOUNT,
      registerPerIp: env.RATE_LIMIT_REGISTER_PER_IP,
      refreshPerIp: env.RATE_LIMIT_REFRESH_PER_IP,
      passwordPerUser: env.RATE_LIMIT_PASSWORD_PER_USER,
      routingPerUser: env.RATE_LIMIT_ROUTING_PER_USER,
      routingPerIp: env.RATE_LIMIT_ROUTING_PER_IP,
      discoveryWindowSeconds: env.RATE_LIMIT_DISCOVERY_WINDOW_SECONDS,
      discoveryPerUser: env.RATE_LIMIT_DISCOVERY_PER_USER,
      discoveryPerIp: env.RATE_LIMIT_DISCOVERY_PER_IP,
    };

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
 * Database settings alone, for tools that touch only PostgreSQL.
 *
 * The migration runner has no use for a JWT secret, and demanding one would mean an
 * operator cannot apply migrations without holding a credential unrelated to the job.
 * Derived from the same schema by projection, so the two cannot drift.
 */
export function loadDatabaseConfig(source: Record<string, unknown>): DatabaseConfig {
  const schema = envSchema.pick({
    DATABASE_URL: true,
    DATABASE_POOL_MAX: true,
    DATABASE_CONNECT_TIMEOUT_MS: true,
    DATABASE_STATEMENT_TIMEOUT_MS: true,
    DATABASE_SSL: true,
  });

  const result = schema.safeParse(source);
  if (!result.success) throw new Error(formatConfigError(result.error));

  return {
    url: result.data.DATABASE_URL,
    poolMax: result.data.DATABASE_POOL_MAX,
    connectTimeoutMs: result.data.DATABASE_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: result.data.DATABASE_STATEMENT_TIMEOUT_MS,
    ssl: result.data.DATABASE_SSL,
  };
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
  assertStructuralInvariants(config);
  assertProductionInvariants(config);
  return config;
}

/** Matches a placeholder regardless of surrounding decoration. */
function isInsecureSecret(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  return INSECURE_SECRETS.some((placeholder) => normalised.includes(placeholder));
}

function formatConfigError(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  return `Invalid environment configuration:\n${issues}`;
}

/**
 * Contradictions that are wrong in any environment.
 *
 * Distinct from the production guards below: those permit a relaxed local setup,
 * whereas a default that exceeds its own maximum is incoherent everywhere and would
 * silently clamp to a value nobody chose.
 */
function assertStructuralInvariants(config: AppConfig): void {
  const violations: string[] = [];

  if (config.routing.corridorDefaultMeters > config.routing.corridorMaxMeters) {
    violations.push('ROUTING_CORRIDOR_DEFAULT_METERS must not exceed ROUTING_CORRIDOR_MAX_METERS');
  }

  if (config.discovery.defaultMaxDetourMinutes > config.discovery.maxDetourMinutes) {
    violations.push(
      'DISCOVERY_DEFAULT_MAX_DETOUR_MINUTES must not exceed DISCOVERY_MAX_DETOUR_MINUTES',
    );
  }

  /* Evaluating more candidates than the spatial query can return is not an error the
     system would ever notice at runtime — it just means one of the two ceilings is
     a lie about what the pipeline does. */
  if (config.discovery.maxDetourCandidates > config.discovery.maxSpatialCandidates) {
    violations.push(
      'DISCOVERY_MAX_DETOUR_CANDIDATES must not exceed DISCOVERY_MAX_SPATIAL_CANDIDATES',
    );
  }

  if (violations.length > 0) {
    throw new Error(`Invalid configuration:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
  }
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

  /* A deployment running on the example secrets is compromised before it starts (§55). */
  if (isInsecureSecret(config.auth.accessTokenSecret)) {
    violations.push('JWT_ACCESS_SECRET is a known placeholder value and must be replaced');
  }
  if (isInsecureSecret(config.auth.ipHashKey)) {
    violations.push('IP_HASH_KEY is a known placeholder value and must be replaced');
  }
  if (config.auth.accessTokenSecret === config.auth.ipHashKey) {
    violations.push('IP_HASH_KEY must not reuse JWT_ACCESS_SECRET');
  }

  /* A placeholder routing token means every route call fails upstream with a 401
     that surfaces as an outage. Better to refuse to start (§11). */
  if (isInsecureSecret(config.routing.accessToken)) {
    violations.push(
      'MAPBOX_ROUTING_ACCESS_TOKEN is a known placeholder value and must be replaced',
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `Invalid production configuration:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }
}
