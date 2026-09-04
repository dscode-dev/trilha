import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfig, loadAppConfig } from './app-config.js';

/**
 * Loads `.env`, validates it, and exposes exactly one `AppConfig` instance
 * process-wide. Global because configuration is a genuine cross-cutting concern —
 * it is the only module in the codebase that earns that.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: false,
      cache: true,
      /* Tests must depend only on the environment they set explicitly, never on a
         developer's local .env file. */
      ignoreEnvFile: process.env['NODE_ENV'] === 'test',
      expandVariables: true,
      // `validate` runs before any provider is constructed: fail fast (§9).
      validate: (raw: Record<string, unknown>) => {
        loadAppConfig(raw);
        return raw;
      },
    }),
  ],
  providers: [
    {
      provide: AppConfig,
      useFactory: (): AppConfig => loadAppConfig(process.env),
    },
  ],
  exports: [AppConfig],
})
export class ConfigModule {}
