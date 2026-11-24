import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatOfficialNumber, provisionalNumber } from "./index.js";

describe("document numbers", () => {
  it("formats official and offline numbers", () => {
    expect(formatOfficialNumber("receipt", 45n)).toBe("R-000045");
    expect(provisionalNumber(3, 45)).toBe("DEV3-000045");
  });

  // The quick sale page uses provisionalNumber. If this file imports zod, all of zod loads with the page.
  it("does not import zod", () => {
    const source = readFileSync(new URL("./document-numbers.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "zod"/);
  });
});
