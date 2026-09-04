import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppConfig } from '../../infrastructure/config/app-config.js';
import { ReadinessService } from './readiness.service.js';
import { HealthResponse, ReadinessResponse } from './health.contract.js';

/**
 * Platform endpoints (§10). These are the only routes PR-00 exposes — no product
 * domain is served yet.
 */
@ApiTags('platform')
@Controller()
export class HealthController {
  constructor(
    private readonly config: AppConfig,
    private readonly readiness: ReadinessService,
  ) {}

  /**
   * Liveness: is this process alive and able to answer?
   * Deliberately touches no dependency — a failing database must not cause an
   * orchestrator to restart an otherwise healthy process.
   */
  @Get('health')
  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Reports that the process is running. Does not check dependencies.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: HealthResponse })
  health(): HealthResponse {
    return {
      status: 'ok',
      service: this.config.serviceName,
      environment: this.config.env,
      uptimeSeconds: Math.round(process.uptime() * 100) / 100,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness: can this process serve real traffic right now?
   * Returns 503 when any required dependency is down, so load balancers drain it.
   */
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description: 'Verifies PostgreSQL and Redis. Returns 503 when any dependency is unavailable.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ReadinessResponse })
  @ApiResponse({ status: HttpStatus.SERVICE_UNAVAILABLE, type: ReadinessResponse })
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    const { ready, dependencies } = await this.readiness.check();

    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ready ? 'ready' : 'not_ready',
      service: this.config.serviceName,
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }
}
