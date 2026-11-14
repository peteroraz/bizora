-- Check existing rows before any DDL. A statement-by-statement apply then
-- stops with the current constraints intact when a row is out of range.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM addresses a WHERE NOT EXISTS (SELECT 1 FROM countries c WHERE c.code = a.country_code) OR (a.subdivision_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM subdivisions s WHERE s.country_code = a.country_code AND s.code = a.subdivision_code))) THEN RAISE EXCEPTION 'addresses reference unknown country or subdivision'; END IF; END $$;

ALTER TABLE addresses DROP CONSTRAINT IF EXISTS addresses_country_fk;
ALTER TABLE addresses
  ADD CONSTRAINT addresses_country_fk
  FOREIGN KEY (country_code) REFERENCES countries (code);

ALTER TABLE addresses DROP CONSTRAINT IF EXISTS addresses_subdivision_fk;
ALTER TABLE addresses
  ADD CONSTRAINT addresses_subdivision_fk
  FOREIGN KEY (country_code, subdivision_code) REFERENCES subdivisions (country_code, code);
