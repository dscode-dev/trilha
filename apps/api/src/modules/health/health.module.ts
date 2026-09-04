import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { CacheModule } from '../../infrastructure/cache/cache.module.js';
import { HealthController } from './health.controller.js';
import { ReadinessService } from './readiness.service.js';

@Module({
  imports: [DatabaseModule, CacheModule],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class HealthModule {}
