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
          message: "Request validation failed.",
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
      response.status(exception.getStatus()).json({
        error: {
          code: exception.code,
          message: exception.message,
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
          message,
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
          message: tooLarge ? "The request is too large." : "The request body could not be read.",
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
        message: "An unexpected error occurred.",
        fieldErrors: [],
        correlationId,
      },
    });
  }
}
