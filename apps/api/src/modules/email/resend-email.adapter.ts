import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { maskEmail, type EmailPort, type OutboundEmail } from "./email.port.js";

/** Tries a message up to three times when the provider is busy or the network drops (ADR-042). */
const ATTEMPTS = 3;
const retryable = (status: number) => status === 429 || status >= 500;

export class ResendEmailAdapter implements EmailPort {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly logger: Logger,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly post: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async send(message: OutboundEmail): Promise<void> {
    // One key for every try, so the provider sends the message once even if a reply was lost.
    const idempotencyKey = randomUUID();
    const context = { to: maskEmail(message.to), kind: message.kind ?? "other", correlationId: message.correlationId };
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let status = 0;
      try {
        const response = await this.post("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
        });
        status = response.status;
        if (response.ok) {
          this.logger.info({ ...context, attempt }, "email sent");
          return;
        }
        if (!retryable(status)) break;
      } catch (error) {
        this.logger.warn({ ...context, attempt, error: error instanceof Error ? error.name : "unknown" }, "email provider could not be reached");
      }
      if (attempt < ATTEMPTS) await this.wait(500 * 3 ** (attempt - 1));
      if (status) this.logger.warn({ ...context, attempt, status }, "email provider busy, trying again");
    }
    this.logger.error(context, "email could not be sent");
    throw new Error("Email could not be sent.");
  }
}
