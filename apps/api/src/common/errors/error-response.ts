import { ApiProperty } from '@nestjs/swagger';
import { ErrorCode } from './error-codes.js';

/**
 * The one and only error envelope this API returns (§11).
 *
 * Declared as a class so `@nestjs/swagger` can document it; it is a wire DTO and
 * carries no behaviour.
 */
export class ErrorBody {
  @ApiProperty({
    enum: Object.values(ErrorCode),
    description: 'Stable machine-readable code. Safe for clients to branch on.',
    example: ErrorCode.NOT_FOUND,
  })
  code!: ErrorCode;

  @ApiProperty({
    description: 'Human-readable summary. Not intended for end-user display verbatim.',
    example: 'Resource not found',
  })
  message!: string;

  @ApiProperty({
    description: 'Correlation id for this request. Quote it when reporting problems.',
    example: '018f4c9e-2a1b-7c3d-9e4f-5a6b7c8d9e0f',
  })
  requestId!: string;

  @ApiProperty({
    required: false,
    type: Object,
    additionalProperties: true,
    description: 'Optional structured context. Never contains internal details.',
  })
  details?: Record<string, unknown>;
}

export class ErrorResponse {
  @ApiProperty({ type: ErrorBody })
  error!: ErrorBody;
}

export function buildErrorResponse(body: ErrorBody): ErrorResponse {
  return { error: body };
}
