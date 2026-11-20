import type { ThrottlerStorage } from "@nestjs/throttler";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface.js";
import { sql } from "drizzle-orm";
import type { AppDatabase } from "../../db/database.js";

type Row = { hits: number; window_ends_at: Date | string; blocked_until: Date | string | null };
const rowsOf = (result: unknown) => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Row[];
// Dates go to Postgres as ISO text; the query layer would otherwise send them in a form Postgres cannot read.
const iso = (time: number) => new Date(time).toISOString();
const ms = (value: Date | string | null) => (value === null ? null : new Date(value).getTime());

/**
 * Sign-in limits kept in Postgres (ADR-036), so every API server counts the same attempts and the API can scale
 * past one instance. Same rules as the built-in store: a fixed window of `ttl`; past `limit` the key is blocked for
 * `blockDuration`, then starts again. Times returned are in seconds, as the guard expects.
 */
export class PostgresThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly db: AppDatabase) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const id = `${throttlerName}:${key}`.slice(0, 255);
    const record = await this.db.transaction(async (tx) => {
      const now = Date.now();
      await tx.execute(sql`INSERT INTO throttle_hits (key, hits, window_ends_at) VALUES (${id}, 0, ${iso(now + ttl)}::timestamptz) ON CONFLICT (key) DO NOTHING`);
      const [row] = rowsOf(await tx.execute(sql`SELECT hits, window_ends_at, blocked_until FROM throttle_hits WHERE key = ${id} FOR UPDATE`));
      let hits = row?.hits ?? 0;
      let windowEnds = ms(row?.window_ends_at ?? null) ?? now + ttl;
      let blockedUntil = ms(row?.blocked_until ?? null);
      if (windowEnds <= now) {
        hits = 0;
        windowEnds = now + ttl;
      }
      // A block that has run out starts the count again.
      if (blockedUntil !== null && blockedUntil <= now) {
        blockedUntil = null;
        hits = 0;
      }
      let blocked = blockedUntil !== null;
      if (!blocked) hits += 1;
      if (!blocked && hits > limit) {
        blocked = true;
        blockedUntil = now + (blockDuration > 0 ? blockDuration : windowEnds - now);
      }
      await tx.execute(
        sql`UPDATE throttle_hits SET hits = ${hits}, window_ends_at = ${iso(windowEnds)}::timestamptz, blocked_until = ${blockedUntil === null ? null : iso(blockedUntil)}::timestamptz WHERE key = ${id}`,
      );
      return {
        totalHits: hits,
        timeToExpire: Math.max(0, Math.ceil((windowEnds - now) / 1000)),
        isBlocked: blocked,
        timeToBlockExpire: blocked && blockedUntil !== null ? Math.max(1, Math.ceil((blockedUntil - now) / 1000)) : 0,
      };
    });
    // Now and then, clear out old keys.
    if (Math.random() < 0.02) {
      await this.db.execute(sql`DELETE FROM throttle_hits WHERE window_ends_at < now() - interval '1 hour' AND (blocked_until IS NULL OR blocked_until < now())`).catch(() => undefined);
    }
    return record;
  }
}
