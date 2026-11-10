import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "password",
        "passwordHash",
        "*.password",
      ],
      censor: "[redacted]",
    },
  });
}
