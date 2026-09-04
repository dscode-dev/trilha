import { All, Controller, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { NotFoundError } from '../errors/app-error.js';

/**
 * Terminal route for anything no controller matched.
 *
 * Without it Express answers with its own HTML 404 page, which bypasses the error
 * filter and breaks the promise that every response uses the `{ error: … }`
 * envelope (§11). Registered last so it can never shadow a real route.
 */
@ApiExcludeController()
@Controller()
export class NotFoundController {
  @All('*path')
  handle(@Req() request: Request): never {
    throw new NotFoundError('Route not found', {
      method: request.method,
      path: request.path,
    });
  }
}
