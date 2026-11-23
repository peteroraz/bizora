import { z } from "zod";

/**
 * Pilot measures (ADR-045): what happened on a phone, never who did it or what was said. The server adds the business;
 * nothing else about the person, the sale or the customer is sent or kept.
 */
export const CLIENT_PILOT_EVENTS = [
  "voice.download_started",
  "voice.download_finished",
  "voice.download_failed",
  "voice.download_cancelled",
  "voice.review_shown",
  "voice.sale_confirmed",
  "voice.review_closed",
  "voice.read_failed",
  "voice.typed_used",
] as const;
export type ClientPilotEvent = (typeof CLIENT_PILOT_EVENTS)[number];

/** A short code only, such as a model name or an error code. */
export const pilotDetailSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,48}$/);

export const pilotEventsSchema = z.object({
  events: z
    .array(z.object({ name: z.enum(CLIENT_PILOT_EVENTS), detail: pilotDetailSchema.optional() }).strict())
    .min(1)
    .max(25),
});
