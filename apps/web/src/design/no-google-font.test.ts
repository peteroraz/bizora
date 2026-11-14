import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("fonts", () => {
  it("loads Geist from the npm package instead of fonts.googleapis.com", () => {
    const layout = readFileSync(path.join(webSrc, "app/layout.tsx"), "utf8");
    const preview = readFileSync(path.join(webSrc, "app/design-preview/preview.tsx"), "utf8");
    expect(layout).not.toContain("next/font/google");
    expect(preview).not.toContain("next/font/google");
    expect(layout).toContain("geist/font/sans");
    expect(layout).toContain("geist/font/mono");
    expect(preview).toContain("geist/font/sans");
  });
});
