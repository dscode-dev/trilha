import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';

import { PasswordHasher } from './infrastructure/password-hasher.js';
import { TokenService } from './infrastructure/token.service.js';
import { SessionRepository } from './infrastructure/session.repository.js';
import { AuthAuditRepository } from './infrastructure/auth-audit.repository.js';
import {
  IdentityAvailabilityRepository,
  UserRepository,
} from './infrastructure/user.repository.js';

import { SessionIssuer } from './application/session-issuer.js';
import { RegisterUseCase } from './application/register.use-case.js';
import { LoginUseCase } from './application/login.use-case.js';
import { RefreshUseCase } from './application/refresh.use-case.js';
import { SessionLifecycleUseCase } from './application/session-lifecycle.use-case.js';
import { ProfileUseCase } from './application/profile.use-case.js';
import { ChangePasswordUseCase } from './application/change-password.use-case.js';

import { AuthController } from './presentation/auth.controller.js';
import { MeController } from './presentation/me.controller.js';
import { AuthGuard } from './presentation/guards/auth.guard.js';
import { AuthRateLimitGuard } from './presentation/guards/auth-rate-limit.guard.js';

/**
 * The identity bounded context (§32).
 *
 * Layers are internal to the module and the dependency direction is inward:
 * `presentation → application → domain`, with `infrastructure` implementing what the
 * inner layers need. Only the guard is exported — that is the single thing other
 * bounded contexts will legitimately need in order to require authentication, and
 * exporting nothing else keeps repositories and use cases from leaking sideways.
 */
@Module({
  imports: [DatabaseModule, RateLimitModule],
  controllers: [AuthController, MeController],
  providers: [
    /* infrastructure */
    PasswordHasher,
    TokenService,
    UserRepository,
    IdentityAvailabilityRepository,
    SessionRepository,
    AuthAuditRepository,

    /* application */
    SessionIssuer,
    RegisterUseCase,
    LoginUseCase,
    RefreshUseCase,
    SessionLifecycleUseCase,
    ProfileUseCase,
    ChangePasswordUseCase,

    /* presentation */
    AuthGuard,
    AuthRateLimitGuard,
  ],
  exports: [AuthGuard],
})
export class IdentityModule {}
