import { Inject, Injectable, Logger } from "@nestjs/common";
import { pilotDetailSchema } from "@bizora/contracts";
import { newId } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { pilotEvents } from "../../db/schema.js";
import { DB } from "../../tokens.js";

const EVENT = /^[a-z][a-z0-9_.]{1,47}$/;

/**
 * Pilot measures (ADR-045). Best effort: a measure that cannot be saved is dropped and logged, and never stops the
 * work it describes. Only an event name and a short code are kept, with the business and the time.
 */
@Injectable()
export class PilotEventsService {
  private readonly logger = new Logger(PilotEventsService.name);

  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async record(tenantId: string, events: { name: string; detail?: string | null | undefined }[]) {
    const rows = events
      .filter((event) => EVENT.test(event.name))
      .map((event) => ({ id: newId(), tenantId, event: event.name, detail: event.detail && pilotDetailSchema.safeParse(event.detail).success ? event.detail : null }));
    if (rows.length === 0) return;
    try {
      await this.db.insert(pilotEvents).values(rows);
    } catch (error) {
      this.logger.warn(`Pilot measures not saved: ${(error as Error).message}`);
    }
  }
}
