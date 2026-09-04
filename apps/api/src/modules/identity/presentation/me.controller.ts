import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { ErrorResponse } from '../../../common/errors/error-response.js';
import { getRequestId } from '../../../common/http/request-context.js';
import { ProfileUseCase } from '../application/profile.use-case.js';
import { ChangePasswordUseCase } from '../application/change-password.use-case.js';
import { TokenService } from '../infrastructure/token.service.js';
import type { UserWithProfile } from '../infrastructure/user.repository.js';
import { AuthGuard } from './guards/auth.guard.js';
import { CurrentUser } from './guards/current-user.decorator.js';
import type { AuthenticatedPrincipal } from './guards/authenticated-request.js';
import { auditContext } from './request-context.helper.js';
import {
  ChangePasswordRequestDto,
  ChangePasswordResponseDto,
  MeDto,
  UpdateProfileRequestDto,
  changePasswordSchema,
  updateProfileSchema,
  type ChangePasswordBody,
  type UpdateProfileBody,
} from './dto/me.dto.js';

/**
 * The authenticated user's own account and profile (§22, §23, §24).
 *
 * Every route requires a live session; there is no way to read another user's record
 * here, which is why PR-01 needs no authorization model beyond authentication (§31).
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly profile: ProfileUseCase,
    private readonly changePassword: ChangePasswordUseCase,
    private readonly tokens: TokenService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Read the authenticated account',
    description: 'Account identity plus the public profile. Never includes credentials.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: MeDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  async me(@CurrentUser() principal: AuthenticatedPrincipal): Promise<MeDto> {
    return toMeDto(await this.profile.getByUserId(principal.userId));
  }

  @Patch('profile')
  @ApiOperation({
    summary: 'Update the public profile',
    description:
      'Only displayName, username and bio are writable in V1. avatarUrl is read-only ' +
      'because object storage does not exist yet.',
  })
  @ApiBody({ type: UpdateProfileRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: MeDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, type: ErrorResponse })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  async updateProfile(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileBody,
  ): Promise<MeDto> {
    const updated = await this.profile.update({
      userId: principal.userId,
      username: body.username,
      displayName: body.displayName,
      bio: body.bio,
      requestId: getRequestId() ?? null,
    });

    return toMeDto(updated);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change the account password',
    description:
      'Requires the current password. On success **every session is revoked, including ' +
      'this one**, so the client must discard its tokens and sign in again.',
  })
  @ApiBody({ type: ChangePasswordRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: ChangePasswordResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  async changeOwnPassword(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordBody,
    @Req() request: Request,
  ): Promise<ChangePasswordResponseDto> {
    return this.changePassword.execute({
      userId: principal.userId,
      sessionId: principal.sessionId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      ...auditContext(request, this.tokens),
    });
  }
}

function toMeDto(user: UserWithProfile): MeDto {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    profile: {
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
    },
  };
}
