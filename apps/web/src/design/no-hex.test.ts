import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webSrc, "../../..");
const uiSrc = path.join(repoRoot, "packages/ui/src");
const hex = /#[0-9A-Fa-f]{3,8}\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx|css)$/.test(entry) ? [full] : [];
  });
}

function allowed(file: string) {
  const relative = file.replaceAll("\\", "/");
  return (
    relative.includes("/design/") ||
    relative.includes("/design-preview/") ||
    relative.endsWith("/packages/ui/src/globals.css") ||
    relative.endsWith("/packages/ui/src/tokens.ts")
  );
}

describe("color tokens", () => {
  it("keeps hex colors inside the token and preview sources", () => {
    const offenders = [...files(webSrc), ...files(uiSrc)].filter((file) => !allowed(file) && hex.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(repoRoot, file))).toEqual([]);
  });
});
