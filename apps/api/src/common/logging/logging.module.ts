import { randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { AppConfig } from '../../infrastructure/config/app-config.js';
import { ConfigModule } from '../../infrastructure/config/config.module.js';
import { REQUEST_ID_HEADER } from '../http/request-context.js';
import { normaliseInboundRequestId } from '../http/request-id.middleware.js';

/**
 * Structured logging (§13).
 *
 * Every line carries service, environment and requestId. Sensitive headers and
 * fields are redacted by pino itself, so a careless `logger.info(req)` cannot leak
 * credentials — redaction is enforced at the sink, not left to call sites.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordConfirmation',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.authorization',
];

/**
 * Shape pino-http passes to its callbacks. Declared as a supertype of pino's own
 * request type so the callbacks stay contravariantly assignable under `strict`.
 */
interface PinoRequest {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  id?: unknown;
}

/* Global so any module can inject a scoped PinoLogger without re-importing the
   transport. Logging is a genuine cross-cutting concern — config and logging are
   the only modules that earn @Global in this codebase. */
@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logging.level,
          base: {
            service: config.serviceName,
            environment: config.env,
          },
          redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
          genReqId: (req: PinoRequest) =>
            normaliseInboundRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID(),
          customProps: (req: PinoRequest) => ({
            requestId: typeof req.id === 'string' ? req.id : undefined,
          }),
          /* Health probes would otherwise dominate the log volume. */
          autoLogging: {
            ignore: (req: PinoRequest) =>
              req.url === '/api/v1/health' || req.url === '/api/v1/ready',
          },
          ...(config.logging.pretty
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
                },
              }
            : {}),
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggingModule {}
