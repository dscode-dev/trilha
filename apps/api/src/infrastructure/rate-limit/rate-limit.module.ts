import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { RateLimiterService } from './rate-limiter.service.js';

@Module({
  imports: [CacheModule],
  providers: [RateLimiterService],
  exports: [RateLimiterService],
})
export class RateLimitModule {}
