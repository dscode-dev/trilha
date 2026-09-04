/**
 * OpenTelemetry bootstrap (§14).
 *
 * Must be imported before any instrumented library so the SDK can patch them, which
 * is why `main.ts` requires this first. Tracing stays entirely opt-in: with no OTLP
 * endpoint configured the SDK is never started and the process pays nothing.
 *
 * Nothing in `src/modules` or the future domain imports this file — the constitution
 * forbids coupling the domain to an observability vendor.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions/incubating';

let sdk: NodeSDK | undefined;

export interface TracingOptions {
  endpoint: string;
  serviceName: string;
  environment: string;
  version: string;
  headers?: string | undefined;
}

export function startTracing(options: TracingOptions): void {
  if (sdk !== undefined) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.version,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${options.endpoint.replace(/\/$/, '')}/v1/traces`,
      ...(options.headers === undefined ? {} : { headers: parseHeaders(options.headers) }),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        /* Noisy and low-value; filesystem spans swamp a trace. */
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
}

export async function stopTracing(): Promise<void> {
  if (sdk === undefined) return;
  await sdk.shutdown();
  sdk = undefined;
}

/** Parses the W3C `key1=value1,key2=value2` form used by OTEL_EXPORTER_OTLP_HEADERS. */
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key.length > 0) headers[key] = value;
  }
  return headers;
}
