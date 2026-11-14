import type { Logger } from "pino";
import type { EmailPort, OutboundEmail } from "./email.port.js";

export class ConsoleEmailAdapter implements EmailPort {
  readonly delivered: OutboundEmail[] = [];

  constructor(private readonly logger: Logger) {}

  async send(message: OutboundEmail): Promise<void> {
    this.delivered.push(message);
    if (this.delivered.length > 50) this.delivered.shift();
    this.logger.info({ to: message.to, subject: message.subject, text: message.text }, "email logged by the console provider");
  }
}
