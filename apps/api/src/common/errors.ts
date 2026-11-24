import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { reportError } from "../logging.js";
import { TENANT_CONTEXT_KEY, type TenantContext } from "./tenant-context.js";

export class ApiError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: number,
    public readonly fieldErrors: { field: string; message: string }[] = [],
  ) {
    super({ code, message, fieldErrors }, status);
  }
}

/** Words people see (pilot readiness, item 21): what happened and what to do, never a framework's own message. */
export const VALIDATION_MESSAGE = "Some details are missing or not right. Check them and try again.";
const STATUS_MESSAGES: Record<number, string> = {
  400: VALIDATION_MESSAGE,
  401: "Sign in again to continue.",
  403: "You do not have permission to do this. Ask the business owner.",
  404: "This could not be found. It may have been removed.",
  405: "This could not be done.",
  409: "This was changed by someone else. Refresh and try again.",
  413: "This is too big to send. Use a smaller photo or file.",
  429: "Too many tries. Wait a minute, then try again.",
};
/** Messages from the framework itself, not written for people: replaced by the plain words above. */
const FRAMEWORK_MESSAGE = /^(Bad Request|Unauthorized|Forbidden( resource)?|Not Found|Cannot (GET|POST|PUT|PATCH|DELETE) |ThrottlerException|Too Many Requests|Validation failed|Method Not Allowed|Conflict|Payload Too Large|Internal Server Error|Unexpected token|Http Exception)/i;

export function plainMessage(status: number, message: string) {
  if (message && !FRAMEWORK_MESSAGE.test(message)) return message;
  return STATUS_MESSAGES[status] ?? (status >= 500 ? unexpectedMessage() : "This could not be done. Try again.");
}

function unexpectedMessage(reference?: string) {
  return `Something went wrong on our side. Try again in a moment.${reference ? ` If it keeps happening, tell Bizora support this code: ${reference.slice(0, 8)}.` : ""}`;
}

/** A missing book account is a fault on our side. Traders never see account codes or JSON. */
export function booksCouldNotSave(correlationId: string | null | undefined) {
  const reference = (correlationId && correlationId.trim().length > 0 ? correlationId : "unknown").slice(0, 8);
  return `Bizora could not save this to your books. Try again, and if it keeps happening, contact support with this code: ${reference}.`;
}

const BOOKS_ACCOUNT_CODES = new Set(["LEDGER_ACCOUNT_NOT_FOUND", "LEDGER_ACCOUNT_AMBIGUOUS"]);

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  constructor(private readonly logger?: Pick<Logger, "error">) {}

  /** Server faults (5xx) go to Error Reporting with the business affected (ADR-036); mistakes by the caller do not. */
  private report(exception: unknown, request: Request & { correlationId?: string; [TENANT_CONTEXT_KEY]?: TenantContext }, status: number) {
    if (!this.logger) {
      console.error(exception);
      return;
    }
    const tenant = request[TENANT_CONTEXT_KEY];
    reportError(this.logger, exception, {
      method: request.method,
      url: request.originalUrl ?? request.url,
      status,
      userId: tenant?.userId ?? null,
      tenantId: tenant?.tenantId ?? null,
      businessId: tenant?.businessId ?? null,
      branchId: tenant?.branchId ?? null,
      correlationId: request.correlationId ?? null,
      userAgent: request.headers["user-agent"] ?? null,
    });
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string; [TENANT_CONTEXT_KEY]?: TenantContext }>();
    const correlationId = request.correlationId ?? "unknown";

    if (exception instanceof ZodError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: "VALIDATION_ERROR",
          message: VALIDATION_MESSAGE,
          fieldErrors: exception.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
          correlationId,
        },
      });
      return;
    }

    if (exception instanceof ApiError) {
      if (exception.getStatus() >= 500) this.report(exception, request, exception.getStatus());
      let message = exception.message;
      if (BOOKS_ACCOUNT_CODES.has(exception.code)) {
        if (message.includes("{") || message.includes("account")) {
          this.logger?.error({ code: exception.code, detail: message, correlationId }, "ledger account could not be resolved");
        }
        message = booksCouldNotSave(correlationId);
      }
      response.status(exception.getStatus()).json({
        error: {
          code: exception.code,
          message,
          fieldErrors: exception.fieldErrors,
          correlationId,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) this.report(exception, request, status);
      const payload = exception.getResponse();
      const message =
        typeof payload === "string"
          ? payload
          : ((payload as { message?: string | string[] }).message?.toString() ?? exception.message);
      response.status(status).json({
        error: {
          code: status === 401 ? "UNAUTHENTICATED" : status === 429 ? "RATE_LIMITED" : "HTTP_ERROR",
          message: status >= 500 ? unexpectedMessage(correlationId) : plainMessage(status, message),
          fieldErrors: [],
          correlationId,
        },
      });
      return;
    }

    // Errors raised by the JSON body parser (too large, malformed) carry a 4xx status and `expose`.
    const parserError = exception as { status?: unknown; expose?: unknown; type?: unknown };
    if (
      typeof parserError?.status === "number" &&
      parserError.status >= 400 &&
      parserError.status < 500 &&
      parserError.expose === true
    ) {
      const tooLarge = parserError.type === "entity.too.large";
      response.status(parserError.status).json({
        error: {
          code: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST_BODY",
          message: tooLarge ? STATUS_MESSAGES[413] : "The details could not be read. Try again.",
          fieldErrors: [],
          correlationId,
        },
      });
      return;
    }

    this.report(exception, request, 500);

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: "INTERNAL_ERROR",
        message: unexpectedMessage(correlationId),
        fieldErrors: [],
        correlationId,
      },
    });
  }
}
