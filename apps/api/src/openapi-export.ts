import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildOpenApiDocument, createApp } from './bootstrap.js';

/**
 * Emits the OpenAPI document to `packages/contracts` without starting a server (§31).
 *
 * The generated file is the machine-readable API contract other codebases consume;
 * it is produced from the running Nest metadata, so it cannot drift from the code.
 */
const OUTPUT_PATH = resolve(
  import.meta.dirname,
  '../../../packages/contracts/openapi/openapi.json',
);

async function exportDocument(): Promise<void> {
  const app = await createApp();
  try {
    const document = buildOpenApiDocument(app);
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ event: 'openapi.exported', path: OUTPUT_PATH }));
  } finally {
    await app.close();
  }
}

exportDocument().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'openapi.export.failed',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
