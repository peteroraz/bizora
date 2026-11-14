import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastPairs, palettes, studioPairs } from "./palettes";
import { contrastRatio, formatRatio, minimumRatio } from "./contrast";
import { designPreviewAllowed } from "./preview-access";

describe("design preview contrast", () => {
  it("meets WCAG AA for every published pair, including the rounded ratio", () => {
    const groups = [
      ...palettes.flatMap((palette) =>
        [palette.light, palette.dark].map((mode) => ({
          name: `${palette.id} ${palette.name} ${mode.id}`,
          pairs: contrastPairs(mode),
        })),
      ),
      { name: "studio", pairs: studioPairs() },
    ];

    for (const group of groups) {
      for (const pair of group.pairs) {
        const ratio = contrastRatio(pair.foreground, pair.background);
        const minimum = minimumRatio(pair.kind);
        const printed = Number(formatRatio(ratio).replace(":1", ""));
        expect(ratio, `${group.name} ${pair.label}`).toBeGreaterThanOrEqual(minimum);
        expect(printed, `printed ${group.name} ${pair.label}`).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  it("offers the three requested directions", () => {
    expect(palettes.map((palette) => palette.name)).toEqual(["Deep green", "Indigo", "Teal"]);
  });
});

describe("design preview access", () => {
  it("is available in development and test, and hidden in production", () => {
    expect(designPreviewAllowed("development")).toBe(true);
    expect(designPreviewAllowed("test")).toBe(true);
    expect(designPreviewAllowed(undefined)).toBe(true);
    expect(designPreviewAllowed("production")).toBe(false);
  });

  it("404s the route in production and shows both money samples", () => {
    const page = readFileSync(new URL("../app/design-preview/page.tsx", import.meta.url), "utf8");
    const specimen = readFileSync(
      new URL("../app/design-preview/specimen.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain("designPreviewAllowed");
    expect(page).toContain("notFound(");
    expect(specimen).toContain("₦1,250,000.00");
    expect(specimen).toContain("$19.99");
  });
});
