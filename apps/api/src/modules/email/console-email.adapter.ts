import type { Logger } from "pino";
import { hideTokens, maskEmail, type EmailPort, type OutboundEmail } from "./email.port.js";

/**
 * Keeps messages in memory (tests read them) and logs them. Links are shown only in local development, where this is
 * how a developer opens an invitation or reset link; anywhere else the tokens are hidden (ADR-042).
 */
export class ConsoleEmailAdapter implements EmailPort {
  readonly delivered: OutboundEmail[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly showLinks = false,
  ) {}

  async send(message: OutboundEmail): Promise<void> {
    this.delivered.push(message);
    if (this.delivered.length > 50) this.delivered.shift();
    this.logger.info(
      { to: this.showLinks ? message.to : maskEmail(message.to), kind: message.kind ?? "other", subject: message.subject, text: this.showLinks ? message.text : hideTokens(message.text) },
      "email logged by the console provider",
    );
  }
}
