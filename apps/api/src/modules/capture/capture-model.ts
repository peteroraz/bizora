import type { CaptureTarget } from "@bizora/contracts";

/** What a capture model is given. Media is in memory only and never stored (ADR-018). */
export type CaptureModelRequest = {
  target: CaptureTarget;
  fields: readonly string[];
  files: { mimeType: string; data: string }[];
  note: string | undefined;
  /** Today in the business's time zone (YYYY-MM-DD), so "yesterday" can be turned into a date. */
  today: string;
  /** The business's product names, so handwritten or spoken names can be matched to them. */
  productNames: string[];
  currency: string;
};

/** The model's raw answer. It is untrusted and is checked by CaptureService before anyone sees it. */
export type CaptureModel = {
  readonly name: string;
  extract(request: CaptureModelRequest, signal: AbortSignal): Promise<unknown>;
};

export const CAPTURE_MODEL = Symbol("CAPTURE_MODEL");
