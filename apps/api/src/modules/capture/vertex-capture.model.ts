import { GoogleGenAI } from "@google/genai";
import { captureInstructions, captureResponseSchema } from "./capture-prompt.js";
import type { CaptureModel, CaptureModelRequest } from "./capture-model.js";

/**
 * Gemini on Vertex AI, in the organization's own Google Cloud project. On Cloud Run it signs in as the API's
 * service account (Application Default Credentials), which needs the Vertex AI User role. No API keys.
 */
export class VertexCaptureModel implements CaptureModel {
  readonly name: string;
  private readonly client: GoogleGenAI;

  constructor(options: { project: string; location: string; model: string }) {
    this.name = options.model;
    this.client = new GoogleGenAI({ vertexai: true, project: options.project, location: options.location });
  }

  async extract(request: CaptureModelRequest, signal: AbortSignal) {
    const { system, user } = captureInstructions(request);
    const response = await this.client.models.generateContent({
      model: this.name,
      contents: [
        {
          role: "user",
          parts: [...request.files.map((file) => ({ inlineData: { mimeType: file.mimeType, data: file.data } })), { text: user }],
        },
      ],
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseSchema: captureResponseSchema(request.fields) as never,
        temperature: 0,
        maxOutputTokens: 32_768,
        abortSignal: signal,
      },
    });
    const text = response.text ?? "";
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("The AI answer was not valid JSON.");
    }
  }
}
