import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = "2026-11-14";

type CurrencySpan = { _from?: string; _to?: string; _tender?: string };
type AddressMeta = {
  id?: string;
  key?: string;
  fmt?: string;
  require?: string;
  zip?: string;
  state_name_type?: string;
};
type MapZone = { _type?: string; _territory?: string };
type WorldCountry = {
  cca2?: string;
  name?: { common?: string };
  idd?: { root?: string; suffixes?: string[] };
  currencies?: Record<string, unknown>;
};

const LABELS: Record<string, string> = {
  area: "Area",
  canton: "Canton",
  county: "County",
  department: "Department",
  district: "District",
  do_si: "Do/Si",
  emirate: "Emirate",
  governorate: "Governorate",
  island: "Island",
  oblast: "Oblast",
  parish: "Parish",
  prefecture: "Prefecture",
  province: "Province",
  region: "Region",
  state: "State",
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("'", "''")}'`;
}

function sqlArray(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return `ARRAY[${values.map(sqlString).join(",")}]::text[]`;
}

function subdivisionLabel(stateNameType: string | undefined): string {
  if (!stateNameType) return "State";
  return LABELS[stateNameType] ?? stateNameType.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function offsetMinutes(timeZone: string): number | null {
  try {
    const date = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
    const hour = parts.hour === "24" ? 0 : Number(parts.hour);
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      hour,
      Number(parts.minute),
      Number(parts.second),
    );
    return Math.round((asUtc - date.getTime()) / 60_000);
  } catch {
    return null;
  }
}

function currentTender(region: unknown): string | null {
  if (!Array.isArray(region)) return null;
  const current: { code: string; from: string }[] = [];
  for (const entry of region) {
    if (!entry || typeof entry !== "object") continue;
    for (const [code, meta] of Object.entries(entry as Record<string, CurrencySpan>)) {
      if (!/^[A-Z]{3}$/.test(code) || meta._tender === "false") continue;
      const from = meta._from ?? "0000-01-01";
      if (from <= today && (!meta._to || meta._to > today)) current.push({ code, from });
    }
  }
  current.sort((a, b) => b.from.localeCompare(a.from) || a.code.localeCompare(b.code));
  return current[0]?.code ?? null;
}

function callingCode(idd: WorldCountry["idd"]): string | null {
  if (!idd?.root?.startsWith("+")) return null;
  if (idd.suffixes?.length === 1 && idd.suffixes[0]) return `${idd.root}${idd.suffixes[0]}`;
  return idd.root;
}

function chooseTimezone(code: string, zones: string[], primaryZones: Record<string, string>, goldenZones: Set<string>): string {
  const unique = [...new Set(zones)].filter(Boolean);
  if (unique.length === 0) return "UTC";
  if (unique.length === 1) return unique[0] ?? "UTC";
  const primary = primaryZones[code];
  if (primary && unique.includes(primary)) return primary;
  const ranked = unique
    .map((zone) => ({ zone, offset: offsetMinutes(zone) }))
    .filter((item): item is { zone: string; offset: number } => item.offset !== null);
  if (ranked.length === 0) return [...unique].sort()[0] ?? "UTC";
  const counts = new Map<number, number>();
  for (const item of ranked) counts.set(item.offset, (counts.get(item.offset) ?? 0) + 1);
  const offsets = [...counts.keys()].sort((a, b) => a - b);
  const median = offsets[Math.floor((offsets.length - 1) / 2)] ?? offsets[0] ?? 0;
  const maxCount = Math.max(...counts.values());
  const target =
    offsets
      .filter((offset) => counts.get(offset) === maxCount)
      .sort((a, b) => Math.abs(a - median) - Math.abs(b - median) || a - b)[0] ?? median;
  const candidates = ranked
    .filter((item) => item.offset === target)
    .sort((a, b) => {
      const goldenDelta = Number(goldenZones.has(b.zone)) - Number(goldenZones.has(a.zone));
      if (goldenDelta !== 0) return goldenDelta;
      const depth = a.zone.split("/").length - b.zone.split("/").length;
      if (depth !== 0) return depth;
      return a.zone.localeCompare(b.zone);
    });
  return candidates[0]?.zone ?? "UTC";
}

function loadAddressMeta(): Map<string, AddressMeta> {
  const text = readFileSync(path.join(root, "data/reference/libaddressinput/countryinfo.txt"), "utf8");
  const meta = new Map<string, AddressMeta>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data/") || !line.includes("=")) continue;
    const parsed = JSON.parse(line.slice(line.indexOf("=") + 1)) as AddressMeta;
    const code = parsed.key?.toUpperCase();
    if (code && /^[A-Z]{2}$/.test(code) && parsed.id === `data/${code}`) meta.set(code, parsed);
  }
  return meta;
}

function loadGoldenZones(): Set<string> {
  const metaZones = readJson<{
    supplemental: { metaZones: { metazones: { mapZone: MapZone | MapZone[] }[] } };
  }>("data/reference/cldr/metaZones.json");
  const golden = new Set<string>();
  for (const entry of metaZones.supplemental.metaZones.metazones) {
    const zones = Array.isArray(entry.mapZone) ? entry.mapZone : [entry.mapZone];
    for (const zone of zones) {
      if (zone._territory === "001" && zone._type) {
        for (const name of zone._type.split(" ")) golden.add(name);
      }
    }
  }
  return golden;
}

const world = readJson<WorldCountry[]>("data/reference/calling/countries.json");
const territoryNames =
  readJson<{ main: { en: { localeDisplayNames: { territories: Record<string, string> } } } }>(
    "data/reference/cldr/territories.json",
  ).main.en.localeDisplayNames.territories;
const currencyRegions = readJson<{ supplemental: { currencyData: { region: Record<string, unknown> } } }>(
  "data/reference/cldr/currencyData.json",
).supplemental.currencyData.region;
const timezoneMap = readJson<Record<string, string[]>>("data/reference/timezones/countries.json");
const primaryZones = readJson<{ supplemental: { primaryZones: Record<string, string> } }>(
  "data/reference/cldr/primaryZones.json",
).supplemental.primaryZones;
const containment = readJson<{
  supplemental: { subdivisionContainment: Record<string, { _contains?: string | string[] }> };
}>("data/reference/cldr/subdivisionContainment.json").supplemental.subdivisionContainment;
const subdivisionNames = readJson<{
  subdivisions: { localeDisplayNames: { subdivisions: Record<string, string> } };
}>("data/reference/cldr/subdivision-names.json").subdivisions.localeDisplayNames.subdivisions;
const addressMeta = loadAddressMeta();
const goldenZones = loadGoldenZones();

type CountryRow = {
  code: string;
  name: string;
  currency: string;
  timezones: string[];
  callingCode: string | null;
  subdivisionLabel: string;
  subdivisionRequired: boolean;
  postalRequired: boolean;
  postalRegex: string | null;
};

type SubdivisionRow = { countryCode: string; code: string; name: string };

const countries: CountryRow[] = [];
const subdivisions: SubdivisionRow[] = [];
const missingTimezones: string[] = [];
const fallbackCurrencies: string[] = [];

for (const entry of world) {
  const code = entry.cca2?.toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code)) continue;
  const cldrName = territoryNames[code];
  const name = (typeof cldrName === "string" && cldrName !== code ? cldrName : entry.name?.common)?.trim();
  if (!name) continue;
  const zones = timezoneMap[code] ?? [];
  if (zones.length === 0) missingTimezones.push(code);
  const suggested = chooseTimezone(code, zones, primaryZones, goldenZones);
  const timezones = [suggested, ...zones.filter((zone) => zone !== suggested).sort()];
  let currency = currentTender(currencyRegions[code]);
  if (!currency) {
    currency = Object.keys(entry.currencies ?? {}).find((item) => /^[A-Z]{3}$/.test(item)) ?? "XXX";
    fallbackCurrencies.push(`${code}:${currency}`);
  }
  const meta = addressMeta.get(code);
  const childKeys = containment[code]?._contains;
  const children = Array.isArray(childKeys) ? childKeys : childKeys ? [childKeys] : [];
  const countrySubdivisions: SubdivisionRow[] = [];
  for (const child of children) {
    const key = child.toLowerCase();
    if (!key.startsWith(code.toLowerCase()) || key.length <= 2) continue;
    const iso = `${code}-${key.slice(2).toUpperCase()}`;
    const subdivisionName = subdivisionNames[key]?.trim();
    if (!subdivisionName) continue;
    countrySubdivisions.push({ countryCode: code, code: iso, name: subdivisionName });
  }
  countrySubdivisions.sort((a, b) => a.code.localeCompare(b.code));
  subdivisions.push(...countrySubdivisions);
  const explicitState = Boolean(meta?.require?.includes("S"));
  const inferredState = !meta?.require && Boolean(meta?.fmt?.includes("%S")) && Boolean(meta?.state_name_type);
  let postalRegex = meta?.zip?.trim() || null;
  if (postalRegex) {
    try {
      RegExp(`^(?:${postalRegex})$`);
    } catch {
      console.warn(`Dropping invalid postal regex for ${code}`);
      postalRegex = null;
    }
  }
  countries.push({
    code,
    name,
    currency,
    timezones,
    callingCode: callingCode(entry.idd),
    subdivisionLabel: subdivisionLabel(meta?.state_name_type),
    subdivisionRequired: (explicitState || inferredState) && countrySubdivisions.length > 0,
    postalRequired: (meta?.require ?? "AC").includes("Z"),
    postalRegex,
  });
}

countries.sort((a, b) => a.code.localeCompare(b.code));

const rules = {
  countries: Object.fromEntries(
    countries.map((country) => [
      country.code,
      {
        subdivisionLabel: country.subdivisionLabel,
        subdivisionRequired: country.subdivisionRequired,
        postalRequired: country.postalRequired,
        postalRegex: country.postalRegex,
        subdivisions: subdivisions.filter((item) => item.countryCode === country.code).map((item) => item.code),
      },
    ]),
  ),
};

function insertBatches(table: string, columns: string, rows: string[], conflict: string): string[] {
  const statements: string[] = [];
  for (let index = 0; index < rows.length; index += 80) {
    const values = rows.slice(index, index + 80).join(",");
    statements.push(`INSERT INTO ${table} (${columns}) VALUES ${values} ON CONFLICT ${conflict};`);
  }
  return statements;
}

const countryRows = countries.map(
  (country) =>
    `(${sqlString(country.code)},${sqlString(country.name)},${sqlString(country.currency)},${sqlArray(country.timezones)},${country.callingCode ? sqlString(country.callingCode) : "NULL"},${sqlString(country.subdivisionLabel)},${country.subdivisionRequired},${country.postalRequired},${country.postalRegex ? sqlString(country.postalRegex) : "NULL"})`,
);
const subdivisionRows = subdivisions.map(
  (item) => `(${sqlString(item.countryCode)},${sqlString(item.code)},${sqlString(item.name)})`,
);

const sql = [
  "-- Generated by scripts/generate-geography-sql.ts",
  "-- Sources: CLDR 47, libaddressinput countryinfo, world-countries 5.1.0, countries-and-timezones 3.8.0",
  "CREATE TABLE IF NOT EXISTS countries (",
  "  code varchar(2) PRIMARY KEY,",
  "  name text NOT NULL,",
  "  default_currency_code varchar(3) NOT NULL,",
  "  timezones text[] NOT NULL,",
  "  calling_code varchar(16),",
  "  subdivision_label text NOT NULL,",
  "  subdivision_required boolean NOT NULL,",
  "  postal_code_required boolean NOT NULL,",
  "  postal_code_regex text",
  ");",
  "CREATE TABLE IF NOT EXISTS subdivisions (",
  "  country_code varchar(2) NOT NULL REFERENCES countries(code),",
  "  code varchar(16) NOT NULL,",
  "  name text NOT NULL,",
  "  PRIMARY KEY (country_code, code)",
  ");",
  ...insertBatches(
    "countries",
    "code, name, default_currency_code, timezones, calling_code, subdivision_label, subdivision_required, postal_code_required, postal_code_regex",
    countryRows,
    "(code) DO UPDATE SET name = EXCLUDED.name, default_currency_code = EXCLUDED.default_currency_code, timezones = EXCLUDED.timezones, calling_code = EXCLUDED.calling_code, subdivision_label = EXCLUDED.subdivision_label, subdivision_required = EXCLUDED.subdivision_required, postal_code_required = EXCLUDED.postal_code_required, postal_code_regex = EXCLUDED.postal_code_regex",
  ),
  ...insertBatches(
    "subdivisions",
    "country_code, code, name",
    subdivisionRows,
    "(country_code, code) DO UPDATE SET name = EXCLUDED.name",
  ),
  "",
].join("\n");

const rulesDir = path.join(root, "packages/contracts/src/geography");
mkdirSync(rulesDir, { recursive: true });
writeFileSync(path.join(root, "apps/api/drizzle/0006_reference_geography.sql"), sql);
writeFileSync(path.join(rulesDir, "rules.json"), JSON.stringify(rules));

const ng = countries.find((country) => country.code === "NG");
const gb = subdivisions.filter((item) => item.countryCode === "GB").map((item) => item.code);
const us = countries.find((country) => country.code === "US");
console.log(
  JSON.stringify(
    {
      countries: countries.length,
      subdivisions: subdivisions.length,
      ngStates: rules.countries.NG?.subdivisions.length,
      ngRequired: ng?.subdivisionRequired,
      ngPostal: ng?.postalRegex,
      ngCalling: ng?.callingCode,
      ngZone: ng?.timezones[0],
      gb,
      usCount: rules.countries.US?.subdivisions.length,
      usZone: us?.timezones[0],
      auZone: countries.find((country) => country.code === "AU")?.timezones[0],
      caZone: countries.find((country) => country.code === "CA")?.timezones[0],
      ruZone: countries.find((country) => country.code === "RU")?.timezones[0],
      usPostalRequired: us?.postalRequired,
      missingTimezones,
      fallbackCurrencies,
    },
    null,
    2,
  ),
);
