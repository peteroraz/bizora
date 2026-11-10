import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const CORRELATION_HEADER = "x-correlation-id";

export function correlationMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header(CORRELATION_HEADER);
  const correlationId = incoming && incoming.trim().length > 0 ? incoming : randomUUID();
  (req as Request & { correlationId: string }).correlationId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  next();
}
