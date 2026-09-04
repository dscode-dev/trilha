import 'reflect-metadata';

import { loadAppConfig } from './infrastructure/config/app-config.js';
import { startTracing, stopTracing } from './infrastructure/observability/tracing.js';
import {
  startErrorReporting,
  stopErrorReporting,
} from './infrastructure/observability/error-reporting.js';
import { API_VERSION, createApp } from './bootstrap.js';

/**
 * Process entrypoint.
 *
 * Order matters: configuration is validated first (fail fast, §9), then tracing is
 * started before any instrumented module is imported, and only then is Nest built.
 */
async function main(): Promise<void> {
  const config = loadAppConfig(process.env);

  if (config.observability.otlpEndpoint !== undefined) {
    startTracing({
      endpoint: config.observability.otlpEndpoint,
      serviceName: config.observability.serviceName,
      environment: config.env,
      version: API_VERSION,
      headers: config.observability.otlpHeaders,
    });
  }

  if (config.observability.sentryDsn !== undefined) {
    startErrorReporting({
      dsn: config.observability.sentryDsn,
      environment: config.env,
      release: API_VERSION,
      tracesSampleRate: config.observability.sentryTracesSampleRate,
    });
  }

  const app = await createApp();

  const shutdown = async (): Promise<void> => {
    await app.close();
    await stopTracing();
    await stopErrorReporting();
  };
  app.enableShutdownHooks();
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen(config.http.port, config.http.host);
}

main().catch((error: unknown) => {
  /* The logger may not exist yet, so emit one structured line and exit non-zero:
     a process that cannot boot must never look healthy. */
  console.error(
    JSON.stringify({
      level: 'fatal',
      event: 'app.bootstrap.failed',
      timestamp: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  process.exit(1);
});
