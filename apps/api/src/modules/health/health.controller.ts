import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { success } from "@bizora/contracts";
import type { AppDatabase } from "../../db/database.js";
import { DB } from "../../tokens.js";

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  @Get("health")
  liveness() {
    return success(
      {
        status: "ok",
        service: "bizora-api",
      },
      "health",
    );
  }

  @Get("ready")
  async readiness() {
    await this.db.execute(sql`SELECT 1`);
    return success(
      {
        status: "ready",
        database: "ok",
      },
      "ready",
    );
  }
}
