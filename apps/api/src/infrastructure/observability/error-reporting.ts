/**
 * Sentry bootstrap (§14).
 *
 * Uses the framework-agnostic `@sentry/node` SDK. `@sentry/nestjs@10` still declares
 * a peer range of NestJS 8–11 and does not support NestJS 12, and forcing an
 * unsupported peer is not a production-grade baseline (see docs/technology-baseline.md).
 *
 * Entirely opt-in: with no DSN configured nothing is initialised or transmitted.
 */
import * as Sentry from '@sentry/node';

let initialised = false;

export interface ErrorReportingOptions {
  dsn: string;
  environment: string;
  release: string;
  tracesSampleRate: number;
}

export function startErrorReporting(options: ErrorReportingOptions): void {
  if (initialised) return;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    tracesSampleRate: options.tracesSampleRate,
    /* OpenTelemetry owns tracing; Sentry is used for error reporting only. */
    skipOpenTelemetrySetup: true,
    /* Defence in depth — the logger redacts too, but a crash report must never
       be the thing that exfiltrates a header. */
    sendDefaultPii: false,
  });

  initialised = true;
}

export async function stopErrorReporting(): Promise<void> {
  if (!initialised) return;
  await Sentry.close(2_000);
  initialised = false;
}

export function isErrorReportingEnabled(): boolean {
  return initialised;
}
