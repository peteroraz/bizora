import pino, { type Logger } from "pino";

const SEVERITY: Record<string, string> = { trace: "DEBUG", debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR", fatal: "CRITICAL" };
const ERROR_EVENT = "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";

/**
 * JSON logs that Cloud Logging understands (ADR-036): `severity` and `message` fields, so errors are coloured and
 * searchable, and error events land in Error Reporting.
 */
export function createLogger(level: string) {
  return pino({
    level,
    messageKey: "message",
    formatters: { level: (label) => ({ severity: SEVERITY[label] ?? "DEFAULT" }) },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "password", "passwordHash", "*.password"],
      censor: "[redacted]",
    },
  });
}

/** Long tokens in a path (receipt and statement links) are replaced, so they never reach the logs. */
export function safePath(url: string) {
  const path = url.split("?")[0] ?? "";
  return path.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/:token").slice(0, 300);
}

export type ErrorContext = {
  service?: string;
  method?: string;
  url?: string;
  status?: number;
  userId?: string | null;
  tenantId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  correlationId?: string | null;
  userAgent?: string | null;
};

/**
 * Sends an error to Cloud Error Reporting through the logs. The stack trace leads the message (Error Reporting
 * groups by it); the organization, business and shop affected go with it so support can see who was hit.
 */
export function reportError(logger: Pick<Logger, "error">, error: unknown, context: ErrorContext = {}) {
  const asError = error instanceof Error ? error : new Error(typeof error === "string" ? error : JSON.stringify(error));
  logger.error({
    "@type": ERROR_EVENT,
    message: asError.stack ?? `${asError.name}: ${asError.message}`,
    serviceContext: { service: context.service ?? "bizora-api", version: process.env.K_REVISION ?? process.env.GIT_SHA ?? "local" },
    context: {
      ...(context.method || context.url
        ? { httpRequest: { method: context.method, url: context.url ? safePath(context.url) : undefined, responseStatusCode: context.status, userAgent: context.userAgent ?? undefined } }
        : {}),
      ...(context.userId ? { user: context.userId } : {}),
    },
    tenantId: context.tenantId ?? undefined,
    businessId: context.businessId ?? undefined,
    branchId: context.branchId ?? undefined,
    correlationId: context.correlationId ?? undefined,
  });
}
