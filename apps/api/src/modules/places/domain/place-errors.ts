import { HttpStatus } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { ErrorCode } from '../../../common/errors/error-codes.js';

export class PlaceNotFoundError extends AppError {
  constructor() {
    super({
      code: ErrorCode.NOT_FOUND,
      message: 'That place could not be found',
      httpStatus: HttpStatus.NOT_FOUND,
    });
  }
}

/** The submitted category is unknown or retired. */
export class UnknownPlaceCategoryError extends AppError {
  constructor(categoryId: string) {
    super({
      code: ErrorCode.VALIDATION_ERROR,
      message: 'That category does not exist',
      httpStatus: HttpStatus.BAD_REQUEST,
      details: { categoryId },
    });
  }
}
