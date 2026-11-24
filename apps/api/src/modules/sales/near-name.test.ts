import { describe, expect, it } from "vitest";
import { closeProductKey, editDistance } from "./near-name.js";

describe("close spellings", () => {
  it("counts edits and only suggests a long name that starts the same way", () => {
    expect(editDistance("ogbono", "ogbona")).toBe(1);
    expect(editDistance("ogbono", "ogbozz")).toBe(2);
    expect(editDistance("ogbono", "ogbxyz")).toBe(3);
    expect(closeProductKey("ogbona", "ogbono")).toBe(true);
    expect(closeProductKey("ogbozz", "ogbono")).toBe(true);
    expect(closeProductKey("ogbxyz", "ogbono")).toBe(false);
    expect(closeProductKey("ogbano", "ogbono")).toBe(false);
    expect(closeProductKey("rice", "ricee")).toBe(false);
    // One digit apart is close enough to suggest, and not close enough to sell as that product.
    expect(closeProductKey("peakmilk400g", "peakmilk900g")).toBe(true);
    expect(closeProductKey("ogbono", "ogbono")).toBe(false);
  });
});