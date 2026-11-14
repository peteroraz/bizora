import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { AppDatabase } from "../../db/database.js";
import { countries, subdivisions } from "../../db/schema.js";
import { DB } from "../../tokens.js";

function trimCode(value: string): string {
  return value.trim();
}

@Injectable()
export class ReferenceService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async listCountries() {
    const rows = await this.db.select().from(countries).orderBy(asc(countries.name));
    return rows.map((row) => ({
      code: trimCode(row.code),
      name: row.name,
      defaultCurrencyCode: trimCode(row.defaultCurrencyCode),
      timezones: row.timezones,
      callingCode: row.callingCode,
      subdivisionLabel: row.subdivisionLabel,
      subdivisionRequired: row.subdivisionRequired,
      postalCodeRequired: row.postalCodeRequired,
      postalCodeRegex: row.postalCodeRegex,
    }));
  }

  async listSubdivisions(countryCode: string) {
    const code = countryCode.trim().toUpperCase();
    const [country] = await this.db.select({ code: countries.code }).from(countries).where(eq(countries.code, code)).limit(1);
    if (!country) {
      throw new ApiError("COUNTRY_NOT_FOUND", "Country was not found.", 404);
    }
    const rows = await this.db
      .select()
      .from(subdivisions)
      .where(eq(subdivisions.countryCode, code))
      .orderBy(asc(subdivisions.name));
    return rows.map((row) => ({
      countryCode: trimCode(row.countryCode),
      code: row.code,
      name: row.name,
    }));
  }
}
