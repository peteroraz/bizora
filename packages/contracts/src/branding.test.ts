import { describe, expect, it } from "vitest";
import { cleanBrandText, contrastWithWhite, updateBrandingSchema } from "./branding.js";

describe("company branding", () => {
  it("tidies the owner's text: spaces, blank lines and hidden characters", () => {
    expect(cleanBrandText("  Thank you!\t\tCome again \r\n\r\n\r\n\r\nGTBank 0123\u0007  ")).toBe("Thank you! Come again\n\nGTBank 0123");
    expect(updateBrandingSchema.parse({ receiptMessage: "   " }).receiptMessage).toBe("");
  });

  it("refuses colours too light for white paper", () => {
    expect(contrastWithWhite("#000000")).toBeCloseTo(21, 0);
    expect(contrastWithWhite("#FFFFFF")).toBeCloseTo(1, 5);
    expect(updateBrandingSchema.safeParse({ primaryColor: "#0B6E4F" }).success).toBe(true);
    expect(updateBrandingSchema.safeParse({ primaryColor: "#FFD700" }).success).toBe(false);
    expect(updateBrandingSchema.safeParse({ receiptMessage: Array.from({ length: 13 }, () => "line").join("\n") }).success).toBe(false);
  });
});
