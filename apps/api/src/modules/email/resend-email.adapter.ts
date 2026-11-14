import type { Logger } from "pino";
import type { EmailPort, OutboundEmail } from "./email.port.js";

export class ResendEmailAdapter implements EmailPort {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly logger: Logger,
  ) {}

  async send(message: OutboundEmail): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!response.ok) {
      this.logger.error({ to: message.to, subject: message.subject, status: response.status }, "email provider rejected the message");
      throw new Error("Email could not be sent.");
    }
  }
}
