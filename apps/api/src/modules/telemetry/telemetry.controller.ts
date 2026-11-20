import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import { reportError, safePath } from "../../logging.js";
import { LOGGER } from "../../tokens.js";

const clientError = z.object({
  kind: z.enum(["error", "unhandledrejection"]).default("error"),
  message: z.string().max(500).default(""),
  stack: z.string().max(4000).optional(),
  url: z.string().max(500).default("/"),
});

/**
 * Problems seen in people's browsers (ADR-036): script errors, and pages the content security policy blocked. Open to
 * anyone, so it is rate-limited, takes small bodies only, never keeps tokens from links, and stores nothing.
 */
@Controller("api/v1/telemetry")
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class TelemetryController {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  @Post("client-errors")
  @HttpCode(204)
  clientError(@Body() body: unknown, @Req() request: Request) {
    const parsed = clientError.safeParse(body ?? {});
    if (!parsed.success) return;
    const { kind, message, stack, url } = parsed.data;
    const where = safePath(url);
    const error = new Error(message || kind);
    // Error Reporting groups by the stack; without one, the page stands in for it.
    error.stack = stack && /\n\s+at /.test(stack) ? stack : `Error: ${message || kind}\n    at ${kind} (${where}:1:1)`;
    reportError(this.logger, error, { service: "bizora-web-browser", method: "GET", url: where, userAgent: request.headers["user-agent"] ?? null });
  }

  @Post("csp")
  @HttpCode(204)
  csp(@Body() body: unknown) {
    const reports = Array.isArray(body) ? body.map((item) => (item as { body?: unknown }).body) : [(body as { "csp-report"?: unknown } | undefined)?.["csp-report"]];
    for (const report of reports.slice(0, 5)) {
      if (!report || typeof report !== "object") continue;
      const value = report as Record<string, unknown>;
      const text = (key: string, other: string) => String(value[key] ?? value[other] ?? "").slice(0, 300);
      this.logger.warn(
        {
          cspViolation: {
            directive: text("effective-directive", "effectiveDirective") || text("violated-directive", "violatedDirective"),
            blocked: safePath(text("blocked-uri", "blockedURL")),
            page: safePath(text("document-uri", "documentURL").replace(/^https?:\/\/[^/]+/, "")),
            source: safePath(text("source-file", "sourceFile")),
            line: Number(value["line-number"] ?? value.lineNumber ?? 0) || undefined,
          },
        },
        "Content security policy blocked something",
      );
    }
  }
}
