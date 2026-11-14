export type OutboundEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface EmailPort {
  send(message: OutboundEmail): Promise<void>;
}
