import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { placeAuditEvents } from '../../../infrastructure/database/schema/places.js';

export const PlaceAuditEventType = {
  PLACE_CREATED: 'PLACE_CREATED',
} as const;

export type PlaceAuditEventType = (typeof PlaceAuditEventType)[keyof typeof PlaceAuditEventType];

export interface PlaceAuditInput {
  eventType: PlaceAuditEventType;
  placeId?: string | null;
  actorUserId?: string | null;
  requestId?: string | null;
  /** Identifiers and counts only — never coordinates or free text (§70). */
  metadata?: Record<string, unknown> | null;
}

/**
 * Append-only audit for the Places domain (§34).
 *
 * Owned by this module rather than shared with identity's log, so the modular
 * boundary from ADR-0001 holds.
 */
@Injectable()
export class PlaceAuditRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PlaceAuditRepository.name);
  }

  /**
   * Best-effort: a failure to audit must not fail the operation being audited, so the
   * error is escalated to the log — itself a durable sink — rather than propagated.
   */
  async record(input: PlaceAuditInput): Promise<void> {
    try {
      await this.database.db.insert(placeAuditEvents).values({
        eventType: input.eventType,
        placeId: input.placeId ?? null,
        actorUserId: input.actorUserId ?? null,
        requestId: input.requestId ?? null,
        metadata: input.metadata ?? null,
      });
    } catch (error) {
      this.logger.error(
        { event: 'places.audit.write_failed', auditEvent: input.eventType, err: error },
        'Failed to persist place audit event',
      );
    }
  }
}
