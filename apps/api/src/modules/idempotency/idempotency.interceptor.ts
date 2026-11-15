import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants.js";
import { Reflector } from "@nestjs/core";
import { IDEMPOTENCY_HEADER, IDEMPOTENT_REPLAY_HEADER, idempotencyKeySchema } from "@bizora/contracts";
import type { Request, Response } from "express";
import { from, lastValueFrom, type Observable } from "rxjs";
import { ApiError } from "../../common/errors.js";
import { TENANT_CONTEXT_KEY, type TenantContext } from "../../common/tenant-context.js";
import { IdempotencyService, requestHash } from "./idempotency.service.js";

const IDEMPOTENT_KEY = "idempotent";

type IdempotentOptions = { required: boolean };

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<IdempotentOptions | undefined>(IDEMPOTENT_KEY, context.getHandler());
    if (!options) return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { [TENANT_CONTEXT_KEY]?: TenantContext; route?: { path?: string } }>();
    const response = http.getResponse<Response>();
    const raw = request.headers[IDEMPOTENCY_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) {
      if (options.required) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header with this request.", 400);
      return next.handle();
    }
    const key = idempotencyKeySchema.safeParse(header);
    if (!key.success) throw new ApiError("IDEMPOTENCY_KEY_INVALID", "The Idempotency-Key header is not valid.", 400);
    const tenant = request[TENANT_CONTEXT_KEY];
    if (!tenant) throw new ApiError("UNAUTHENTICATED", "Authentication is required.", 401);
    const scope = `${request.method} ${request.route?.path ?? request.path}`;
    // Nest sets the status after interceptors finish, so read it from @HttpCode or the method default.
    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ?? (request.method === "POST" ? 201 : 200);
    const hash = requestHash(`${scope} ${request.path}`, request.body);
    return from(
      this.idempotency
        .run({ tenantId: tenant.tenantId, membershipId: tenant.membershipId }, key.data, scope, hash, async () => {
          const value = await lastValueFrom(next.handle());
          return { value, status: successStatus };
        })
        .then((outcome) => {
          if (outcome.kind === "fresh") return outcome.value;
          response.setHeader(IDEMPOTENT_REPLAY_HEADER, "true");
          response.status(outcome.status);
          return outcome.body;
        }),
    );
  }
}

/** Marks a write as idempotent. With `required`, requests without an Idempotency-Key are refused. */
export function Idempotent(options: IdempotentOptions = { required: false }) {
  return applyDecorators(SetMetadata(IDEMPOTENT_KEY, options), UseInterceptors(IdempotencyInterceptor));
}
