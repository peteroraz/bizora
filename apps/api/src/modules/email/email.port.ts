/** What an email is for, so logs and audit can say so without the content (ADR-042). */
export type EmailKind = "verify_email" | "password_reset" | "password_changed" | "invitation" | "receipt" | "support_access";

export type OutboundEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind?: EmailKind;
  correlationId?: string;
};

export interface EmailPort {
  send(message: OutboundEmail): Promise<void>;
}

/** "ngozi@shop.ng" → "n***@shop.ng": enough to tell messages apart in logs, not enough to harvest addresses. */
export function maskEmail(address: string) {
  const [name = "", domain = ""] = address.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

/** Links in emails carry one-time tokens; they are never written to logs. */
export function hideTokens(text: string) {
  return text.replace(/([?&](?:token|code)=)[^\s&"'<>]+/gi, "$1[hidden]").replace(/(\/r\/)[A-Za-z0-9_-]{20,64}/g, "$1[hidden]");
}
