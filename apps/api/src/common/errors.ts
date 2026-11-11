import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";

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
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string }>();
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
      const payload = exception.getResponse();
      const message =
        typeof payload === "string"
          ? payload
          : ((payload as { message?: string | string[] }).message?.toString() ?? exception.message);
      response.status(status).json({
        error: {
          code: status === 401 ? "UNAUTHENTICATED" : "HTTP_ERROR",
          message,
          fieldErrors: [],
          correlationId,
        },
      });
      return;
    }

    console.error(exception);

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
