import { ApiProperty } from '@nestjs/swagger';

export const DependencyStatus = { UP: 'up', DOWN: 'down' } as const;
export type DependencyStatus = (typeof DependencyStatus)[keyof typeof DependencyStatus];

export class DependencyHealth {
  @ApiProperty({ enum: Object.values(DependencyStatus), example: DependencyStatus.UP })
  status!: DependencyStatus;

  @ApiProperty({ description: 'Round-trip duration of the probe, in milliseconds.' })
  durationMs!: number;

  @ApiProperty({
    required: false,
    description: 'Client-safe reason the dependency is down. Never contains connection strings.',
  })
  reason?: string;
}

export class HealthResponse {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: 'trilha-api' })
  service!: string;

  @ApiProperty({ example: 'development' })
  environment!: string;

  @ApiProperty({ description: 'Process uptime in seconds.', example: 12.34 })
  uptimeSeconds!: number;

  @ApiProperty({ example: '2026-09-04T12:00:00.000Z' })
  timestamp!: string;
}

export class ReadinessResponse {
  @ApiProperty({ enum: ['ready', 'not_ready'], example: 'ready' })
  status!: 'ready' | 'not_ready';

  @ApiProperty({ example: 'trilha-api' })
  service!: string;

  @ApiProperty({ example: '2026-09-04T12:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'object' },
    description: 'Per-dependency probe results.',
  })
  dependencies!: Record<string, DependencyHealth>;
}
