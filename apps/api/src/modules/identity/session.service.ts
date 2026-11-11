import { Inject, Injectable } from "@nestjs/common";
import {
  REFRESH_COOKIE,
  SESSION_COOKIE,
  newRefreshToken,
  readBearerToken,
  readCookieValue,
  sha256Hex,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import { ttlToMs } from "@bizora/config/env";
import type { Role } from "@bizora/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { Request } from "express";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { sessions } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";

export type IssuedTokens = {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async issue(input: {
    userId: string;
    tenantId: string | null;
    membershipId: string | null;
    businessId: string | null;
    branchId: string | null;
    role?: Role;
    typ: "access" | "preauth";
    familyId?: string;
    userAgent?: string | null;
    ip?: string | null;
  }): Promise<IssuedTokens> {
    const sessionId = newId();
    const familyId = input.familyId ?? newId();
    const refreshToken = newRefreshToken();
    const expiresAt = new Date(Date.now() + ttlToMs(this.env.JWT_REFRESH_TTL));
    await this.db.insert(sessions).values({
      id: sessionId,
      userId: input.userId,
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      businessId: input.businessId,
      branchId: input.branchId,
      refreshTokenHash: sha256Hex(refreshToken),
      familyId,
      expiresAt,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    });
    const accessToken = await signAccessToken(
      {
        sub: input.userId,
        sid: sessionId,
        typ: input.typ,
        org: input.tenantId ?? undefined,
        mid: input.membershipId ?? undefined,
        bid: input.businessId,
        br: input.branchId,
      },
      this.env.JWT_SECRET,
      this.env.JWT_ACCESS_TTL,
    );
    return { sessionId, accessToken, refreshToken };
  }

  async revoke(sessionId: string, userId: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  async refresh(rawToken: string, meta?: { userAgent?: string | null; ip?: string | null }): Promise<IssuedTokens> {
    const hash = sha256Hex(rawToken);
    const [current] = await this.db.select().from(sessions).where(eq(sessions.refreshTokenHash, hash)).limit(1);
    if (!current) {
      throw new ApiError("UNAUTHENTICATED", "Refresh token is invalid.", 401);
    }
    if (current.revokedAt) {
      await this.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.familyId, current.familyId), isNull(sessions.revokedAt)));
      throw new ApiError("UNAUTHENTICATED", "Refresh token reuse detected.", 401);
    }
    if (current.expiresAt.getTime() < Date.now()) {
      throw new ApiError("UNAUTHENTICATED", "Refresh token has expired.", 401);
    }

    const sessionId = newId();
    const refreshToken = newRefreshToken();
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(sessions)
        .set({ revokedAt: new Date(), replacedBy: sessionId })
        .where(and(eq(sessions.id, current.id), eq(sessions.userId, current.userId), isNull(sessions.revokedAt)))
        .returning();
      if (!row) {
        return null;
      }
      await tx.insert(sessions).values({
        id: sessionId,
        userId: current.userId,
        tenantId: current.tenantId,
        membershipId: current.membershipId,
        businessId: current.businessId,
        branchId: current.branchId,
        refreshTokenHash: sha256Hex(refreshToken),
        familyId: current.familyId,
        expiresAt: new Date(Date.now() + ttlToMs(this.env.JWT_REFRESH_TTL)),
        userAgent: meta?.userAgent ?? current.userAgent,
        ip: meta?.ip ?? current.ip,
      });
      return row;
    });
    if (!claimed) {
      await this.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.familyId, current.familyId), isNull(sessions.revokedAt)));
      throw new ApiError("UNAUTHENTICATED", "Refresh token reuse detected.", 401);
    }

    const accessToken = await signAccessToken(
      {
        sub: current.userId,
        sid: sessionId,
        typ: current.membershipId ? "access" : "preauth",
        org: current.tenantId ?? undefined,
        mid: current.membershipId ?? undefined,
        bid: current.businessId,
        br: current.branchId,
      },
      this.env.JWT_SECRET,
      this.env.JWT_ACCESS_TTL,
    );
    return { sessionId, accessToken, refreshToken };
  }

  async requireIdentity(request: Request) {
    const token = this.readAccessToken(request);
    if (!token) {
      throw new ApiError("UNAUTHENTICATED", "Authentication is required.", 401);
    }
    let claims: AccessTokenClaims;
    try {
      claims = await verifyAccessToken(token, this.env.JWT_SECRET);
    } catch {
      throw new ApiError("UNAUTHENTICATED", "Session is invalid or expired.", 401);
    }
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, claims.sid), eq(sessions.userId, claims.sub)))
      .limit(1);
    if (!session || session.revokedAt) {
      throw new ApiError("UNAUTHENTICATED", "Session is no longer valid.", 401);
    }
    return { claims, userId: claims.sub, sessionId: session.id, session };
  }

  readAccessToken(request: Request) {
    return (
      readBearerToken(request.headers.authorization) ?? readCookieValue(request.headers.cookie, SESSION_COOKIE)
    );
  }

  readRefreshToken(request: Request, bodyToken?: string) {
    return bodyToken ?? readCookieValue(request.headers.cookie, REFRESH_COOKIE);
  }
}
