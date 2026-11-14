# ADR-006: Reference geography

## Status

Accepted for Sprint 3A.

## Context

Onboarding and addresses need every ISO country and its first-level subdivisions, plus calling codes, default currency, time zones, and postal rules. Country packs stay the richer configuration for the countries Bizora knows well. They are not the complete list.

## Decision

Vendored inputs live in `data/reference` and are the only source for `scripts/generate-geography-sql.ts`:

- Unicode CLDR 47 (`cldr-json` tag 47.0.0): English territory names, current tender currency, subdivision containment, English subdivision names, primary zones, and meta-zone golden zones. Unicode License.
- Google libaddressinput `countryinfo.txt`, snapshotted 2026-11-14: address labels, required fields, and postal patterns. Apache-2.0. Only `data/CC` country rows are used.
- `world-countries` 5.1.0: the country set and calling codes (`idd`). ODbL.
- `countries-and-timezones` 3.8.0: IANA zones per country, extracted to `data/reference/timezones/countries.json`. MIT.

The generator writes `apps/api/drizzle/0006_reference_geography.sql` and `packages/contracts/src/geography/rules.json`. Both use idempotent upserts. Businesses do not foreign-key to `countries`, so an unknown code fails in the API instead of breaking older rows.

A country requires a subdivision when libaddressinput `require` contains `S`, or when `require` is absent, the format contains `%S`, a subdivision label exists, and CLDR has first-level subdivisions. That makes Nigerian states required. The United Kingdom's counties are optional. Postal patterns are anchored. The first timezone in each country row is a suggested default (single zone, otherwise the CLDR primary zone, otherwise the most common offset's golden zone) and stays editable. Bouvet Island, Heard Island, and Kosovo fall back to `UTC` because the timezone extract has no entry. Antarctica's currency is `XXX`.

## Consequences

Regenerate SQL and rules from the vendored files. Do not hand-edit either output. Country packs remain the rich defaults for NG, GB, US, KE, ZA, and GH.
