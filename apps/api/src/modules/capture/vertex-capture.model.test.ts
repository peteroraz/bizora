import { CAPTURE_FIELDS } from "@bizora/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
const constructed: unknown[] = [];
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
    constructor(options: unknown) {
      constructed.push(options);
    }
  },
}));

const { VertexCaptureModel } = await import("./vertex-capture.model.js");

describe("Gemini on Vertex AI", () => {
  beforeEach(() => generateContent.mockReset());

  it("signs in to the organization's own project and asks for JSON rows with the photo attached", async () => {
    generateContent.mockResolvedValue({ text: '{"rows":[{"product":"Peak Milk"}],"warnings":[],"transcript":""}' });
    const model = new VertexCaptureModel({ project: "bizora-staging", location: "global", model: "gemini-3.8-flash" });
    const signal = new AbortController().signal;
    const answer = await model.extract(
      { target: "stock_in", fields: CAPTURE_FIELDS.stock_in, files: [{ mimeType: "image/jpeg", data: "AAAA" }], note: undefined, today: "2026-11-16", productNames: ["Peak Milk"], currency: "NGN" },
      signal,
    );
    expect(answer).toEqual({ rows: [{ product: "Peak Milk" }], warnings: [], transcript: "" });
    expect(constructed[0]).toEqual({ vertexai: true, project: "bizora-staging", location: "global" });
    const call = generateContent.mock.calls[0]?.[0];
    expect(call.model).toBe("gemini-3.8-flash");
    expect(call.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/jpeg", data: "AAAA" } });
    expect(call.contents[0].parts[1].text).toContain("Peak Milk");
    expect(call.config).toMatchObject({ responseMimeType: "application/json", temperature: 0, abortSignal: signal });
    expect(call.config.systemInstruction).toContain("DATA");
  });

  it("reports an answer that is not JSON as a failure", async () => {
    generateContent.mockResolvedValue({ text: "Sorry, I cannot read this." });
    const model = new VertexCaptureModel({ project: "p", location: "global", model: "m" });
    await expect(
      model.extract({ target: "sales", fields: CAPTURE_FIELDS.sales, files: [{ mimeType: "audio/webm", data: "AAAA" }], note: undefined, today: "2026-11-16", productNames: [], currency: "NGN" }, new AbortController().signal),
    ).rejects.toThrow("not valid JSON");
  });
});
