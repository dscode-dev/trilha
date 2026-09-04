import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * NestJS 12 is ESM-only, so the API is an ESM package and Vitest is the test
 * runner (see docs/technology-baseline.md).
 *
 * Vitest's default esbuild transform cannot emit `design:paramtypes`, which Nest's
 * DI container requires, so SWC does the TypeScript transform instead.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/openapi-export.ts', 'src/**/*.spec.ts', 'src/**/*.int-spec.ts'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts', 'test/unit/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          // Requires the real services from infra/local/docker-compose.yml (§24).
          include: ['test/integration/**/*.int-spec.ts'],
          setupFiles: ['test/integration/setup-env.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Suites share one database; run them serially to keep state predictable.
          fileParallelism: false,
        },
      },
    ],
  },
});
