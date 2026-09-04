import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { emailSchema } from '../../domain/email.js';
import { passwordSchema } from '../../domain/password-policy.js';
import { usernameSchema } from '../../domain/username.js';

/**
 * Transport contracts for the auth endpoints.
 *
 * Each shape is declared twice on purpose: a Zod schema, which is what actually
 * validates at runtime, and a class carrying `@ApiProperty`, which is what
 * `@nestjs/swagger` reads to build the published contract. Nest's decorator-based
 * validation is not used here — Zod is the single validator in this codebase (PR-00).
 */

/** Optional, client-declared context used only to label a session (§18). */
const deviceSchema = z
  .object({
    deviceName: z.string().trim().min(1).max(80).optional(),
    platform: z.enum(['ios', 'android', 'web']).optional(),
    appVersion: z.string().trim().min(1).max(40).optional(),
  })
  .optional();

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(80),
  device: deviceSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().min(1).max(320),
  /* Not `passwordSchema`: policy applies when choosing a password, not when
     presenting one. Validating it here would reject legacy passwords and leak the
     policy to an attacker before authentication. */
  password: z.string().min(1).max(512),
  device: deviceSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;

/* ---- OpenAPI documentation shapes (§62) ---------------------------------- */

export class DeviceDto {
  @ApiPropertyOptional({ example: 'Pixel 8', maxLength: 80 })
  deviceName?: string;

  @ApiPropertyOptional({ enum: ['ios', 'android', 'web'] })
  platform?: 'ios' | 'android' | 'web';

  @ApiPropertyOptional({ example: '0.1.0', maxLength: 40 })
  appVersion?: string;
}

export class RegisterRequestDto {
  @ApiProperty({ format: 'email', example: 'ana@example.com' })
  email!: string;

  @ApiProperty({
    minLength: 12,
    maxLength: 128,
    description: 'At least 12 characters. Passphrases are encouraged.',
    example: 'a quiet trail through pine',
  })
  password!: string;

  @ApiProperty({
    minLength: 3,
    maxLength: 30,
    description: 'Letters and numbers, optionally separated by a single - or _.',
    example: 'ana-souza',
  })
  username!: string;

  @ApiProperty({ maxLength: 80, example: 'Ana Souza' })
  displayName!: string;

  @ApiPropertyOptional({ type: DeviceDto })
  device?: DeviceDto;
}

export class LoginRequestDto {
  @ApiProperty({ format: 'email', example: 'ana@example.com' })
  email!: string;

  @ApiProperty({ description: 'The account password.', example: 'a quiet trail through pine' })
  password!: string;

  @ApiPropertyOptional({ type: DeviceDto })
  device?: DeviceDto;
}

export class RefreshRequestDto {
  @ApiProperty({
    description: 'The opaque refresh token from the previous authentication response.',
  })
  refreshToken!: string;
}

export class AuthTokensDto {
  @ApiProperty({ description: 'Short-lived bearer token for the Authorization header.' })
  accessToken!: string;

  @ApiProperty({
    description:
      'Opaque, single-use token. Rotated on every refresh; the previous value is ' +
      'invalidated and replaying it revokes the session.',
  })
  refreshToken!: string;

  @ApiProperty({ example: 600, description: 'Seconds until the access token expires.' })
  expiresIn!: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';
}
