import { Module } from '@nestjs/common';
import { NotFoundController } from './not-found.controller.js';

/** Must be the last module imported by AppModule — its route matches everything. */
@Module({ controllers: [NotFoundController] })
export class NotFoundModule {}
