import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { ErrorResponse } from '../../../common/errors/error-response.js';
import { RegisterUseCase } from '../application/register.use-case.js';
import { LoginUseCase } from '../application/login.use-case.js';
import { RefreshUseCase } from '../application/refresh.use-case.js';
import { SessionLifecycleUseCase } from '../application/session-lifecycle.use-case.js';
import { TokenService } from '../infrastructure/token.service.js';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard.js';
import { AuthGuard } from './guards/auth.guard.js';
import { CurrentUser } from './guards/current-user.decorator.js';
import type { AuthenticatedPrincipal } from './guards/authenticated-request.js';
import { auditContext, toDeviceContext } from './request-context.helper.js';
import {
  AuthTokensDto,
  LoginRequestDto,
  RefreshRequestDto,
  RegisterRequestDto,
  loginSchema,
  refreshSchema,
  registerSchema,
  type LoginBody,
  type RefreshBody,
  type RegisterBody,
} from './dto/auth.dto.js';
import { LogoutAllResponseDto } from './dto/me.dto.js';

/**
 * Authentication transport (§33).
 *
 * Handlers parse, delegate to one use case, and map the result. No hashing, no
 * queries, no token minting happens here.
 */
@ApiTags('auth')
@Controller('auth')
@UseGuards(AuthRateLimitGuard)
export class AuthController {
  constructor(
    private readonly register: RegisterUseCase,
    private readonly login: LoginUseCase,
    private readonly refresh: RefreshUseCase,
    private readonly lifecycle: SessionLifecycleUseCase,
    private readonly tokens: TokenService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Creates the account and signs it in through the same session pipeline as login. ' +
      'Unlike login, this endpoint does disclose whether an email or username is taken — ' +
      'a signup form cannot work otherwise (see ADR-0008).',
  })
  @ApiBody({ type: RegisterRequestDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: AuthTokensDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, type: ErrorResponse })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, type: ErrorResponse })
  async registerAccount(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterBody,
    @Req() request: Request,
  ): Promise<AuthTokensDto> {
    const { session } = await this.register.execute({
      email: body.email,
      password: body.password,
      username: body.username,
      displayName: body.displayName,
      device: toDeviceContext(body.device),
      ...auditContext(request, this.tokens),
    });

    return toTokensDto(session);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Returns an identical error for an unknown address and a wrong password, and ' +
      'spends comparable time on both, so the endpoint cannot be used to discover ' +
      'which addresses are registered.',
  })
  @ApiBody({ type: LoginRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: AuthTokensDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, type: ErrorResponse })
  async signIn(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginBody,
    @Req() request: Request,
  ): Promise<AuthTokensDto> {
    const { session } = await this.login.execute({
      email: body.email,
      password: body.password,
      device: toDeviceContext(body.device),
      ...auditContext(request, this.tokens),
    });

    return toTokensDto(session);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the session tokens',
    description:
      'Consumes the presented refresh token and issues a new pair. Rotation is ' +
      'single-use: presenting a token that was already rotated is treated as ' +
      'compromise and revokes the whole session.',
  })
  @ApiBody({ type: RefreshRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: AuthTokensDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  async rotate(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshBody,
    @Req() request: Request,
  ): Promise<AuthTokensDto> {
    const result = await this.refresh.execute({
      refreshToken: body.refreshToken,
      ...auditContext(request, this.tokens),
    });

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.accessTokenExpiresInSeconds,
      tokenType: 'Bearer',
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'End the current session',
    description:
      'Revokes this session and its refresh tokens. An access token already issued ' +
      'remains valid until it expires — at most the configured access TTL.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  async signOut(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.lifecycle.logout({
      userId: principal.userId,
      sessionId: principal.sessionId,
      ...auditContext(request, this.tokens),
    });
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'End every session',
    description: 'Revokes all sessions for the account, including the one making the request.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LogoutAllResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  async signOutEverywhere(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<LogoutAllResponseDto> {
    return this.lifecycle.logoutAll({
      userId: principal.userId,
      sessionId: principal.sessionId,
      ...auditContext(request, this.tokens),
    });
  }
}

function toTokensDto(session: {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
}): AuthTokensDto {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.accessTokenExpiresInSeconds,
    tokenType: 'Bearer',
  };
}
