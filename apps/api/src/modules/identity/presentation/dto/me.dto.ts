import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { passwordSchema } from '../../domain/password-policy.js';
import { usernameSchema } from '../../domain/username.js';

export const BIO_MAX_LENGTH = 280;

/**
 * At least one field must be present: an empty PATCH is a client bug, and silently
 * accepting it would return 200 for an update that never happened.
 */
export const updateProfileSchema = z
  .object({
    username: usernameSchema.optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    /* `null` clears the bio; omitted leaves it untouched. */
    bio: z.string().trim().max(BIO_MAX_LENGTH).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(512),
    newPassword: passwordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'The new password must differ from the current one',
    path: ['newPassword'],
  });

export type UpdateProfileBody = z.infer<typeof updateProfileSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

/* ---- OpenAPI documentation shapes ---------------------------------------- */

export class ProfileDto {
  @ApiProperty({ example: 'ana-souza' })
  username!: string;

  @ApiProperty({ example: 'Ana Souza' })
  displayName!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Always null in V1 — avatar upload is not implemented yet.',
    example: null,
  })
  avatarUrl!: string | null;

  @ApiProperty({ nullable: true, type: String, maxLength: BIO_MAX_LENGTH, example: null })
  bio!: string | null;
}

export class MeDto {
  @ApiProperty({ format: 'uuid', example: '01a06cc8-9b3a-7ba0-879e-f01610559f9c' })
  id!: string;

  @ApiProperty({ format: 'email', example: 'ana@example.com' })
  email!: string;

  @ApiProperty({ enum: ['ACTIVE', 'DISABLED', 'PENDING'], example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ type: ProfileDto })
  profile!: ProfileDto;
}

export class UpdateProfileRequestDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 30, example: 'ana-souza' })
  username?: string;

  @ApiPropertyOptional({ maxLength: 80, example: 'Ana Souza' })
  displayName?: string;

  @ApiPropertyOptional({
    maxLength: BIO_MAX_LENGTH,
    nullable: true,
    type: String,
    description: 'Send null to clear it.',
  })
  bio?: string | null;
}

export class ChangePasswordRequestDto {
  @ApiProperty({ description: 'The password currently on the account.' })
  currentPassword!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  newPassword!: string;
}

export class ChangePasswordResponseDto {
  @ApiProperty({
    example: 2,
    description:
      'Sessions revoked by this change. Every session is revoked, including the ' +
      'caller’s, so the client must sign in again.',
  })
  revokedSessions!: number;
}

export class LogoutAllResponseDto {
  @ApiProperty({ example: 3 })
  revokedCount!: number;
}
