import { Inject, Injectable } from "@nestjs/common";
import {
  DEVICE_COOKIE,
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
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { Request } from "express";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { sessions, shopDevices } from "../../db/schema.js";
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
    /** Set for staff PIN sessions: the session only works together with that device's cookie. */
    deviceId?: string | null;
  }): Promise<IssuedTokens> {
    const sessionId = newId();
    const familyId = input.familyId ?? newId();
    const refreshToken = newRefreshToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlMs(input.deviceId ?? null));
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
      deviceId: input.deviceId ?? null,
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

  async listActive(userId: string) {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  }

  async revokeAllForUser(userId: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  async revokeOthers(userId: string, sessionId: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), ne(sessions.id, sessionId)));
  }

  /** Revoke every live session created on a shop device (device revoked or suspended). */
  async revokeAllForDevice(deviceId: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)));
  }

  async revoke(sessionId: string, userId: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  async refresh(
    rawToken: string,
    meta?: { userAgent?: string | null; ip?: string | null; deviceToken?: string | null },
  ): Promise<IssuedTokens> {
    const hash = sha256Hex(rawToken);
    const [current] = await this.db.select().from(sessions).where(eq(sessions.refreshTokenHash, hash)).limit(1);
    if (!current) {
      throw new ApiError("UNAUTHENTICATED", "Refresh token is invalid.", 401);
    }
    if (current.deviceId) {
      await this.assertDeviceBinding(current.deviceId, current.tenantId, meta?.deviceToken ?? null);
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
        expiresAt: new Date(Date.now() + this.refreshTtlMs(current.deviceId)),
        userAgent: meta?.userAgent ?? current.userAgent,
        ip: meta?.ip ?? current.ip,
        deviceId: current.deviceId,
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
    if (session.deviceId) {
      await this.assertDeviceBinding(session.deviceId, session.tenantId, this.readDeviceToken(request));
    }
    return { claims, userId: claims.sub, sessionId: session.id, session };
  }

  /**
   * A staff PIN session is only valid on the shop device it was created on: the request must carry
   * that device's cookie, and the device must not be revoked or suspended.
   */
  async assertDeviceBinding(deviceId: string, tenantId: string | null, deviceToken: string | null) {
    if (!deviceToken || !tenantId) {
      throw new ApiError("UNAUTHENTICATED", "This session only works on its shop device.", 401);
    }
    const [device] = await this.db
      .select()
      .from(shopDevices)
      .where(and(eq(shopDevices.id, deviceId), eq(shopDevices.tenantId, tenantId)))
      .limit(1);
    if (!device || device.tokenHash !== sha256Hex(deviceToken) || device.revokedAt || device.suspendedAt) {
      throw new ApiError("UNAUTHENTICATED", "This shop device is no longer allowed.", 401);
    }
  }

  readDeviceToken(request: Request) {
    return readCookieValue(request.headers.cookie, DEVICE_COOKIE);
  }

  private refreshTtlMs(deviceId: string | null) {
    return ttlToMs(deviceId ? (this.env.STAFF_SESSION_TTL ?? "12h") : this.env.JWT_REFRESH_TTL);
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
