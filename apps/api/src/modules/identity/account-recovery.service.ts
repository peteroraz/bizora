import { Inject, Injectable } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import { publicWebOrigin } from "@bizora/config/env";
import { forgotPasswordSchema, resetPasswordSchema, verifyEmailSchema } from "@bizora/contracts";
import { hashPassword } from "@bizora/auth";
import { and, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { ApiError } from "../../common/errors.js";
import type { AppDatabase } from "../../db/database.js";
import { sessions, users } from "../../db/schema.js";
import { APP_ENV, DB, EMAIL, LOGGER } from "../../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import type { EmailPort } from "../email/email.port.js";
import { renderEmail } from "../email/templates.js";
import { AuthTokenService } from "./auth-token.service.js";

type AuthMeta = { correlationId: string; ip?: string | null; userAgent?: string | null };

const verifyTtlMs = 24 * 60 * 60 * 1000;
const resetTtlMs = 30 * 60 * 1000;
const accepted = { ok: true as const };

@Injectable()
export class AccountRecoveryService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(EMAIL) private readonly email: EmailPort,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuthTokenService) private readonly tokens: AuthTokenService,
  ) {}

  async sendVerification(userId: string, address: string): Promise<void> {
    try {
      const token = await this.tokens.issue(userId, "verify_email", verifyTtlMs);
      const link = `${publicWebOrigin(this.env)}/verify-email?token=${encodeURIComponent(token)}`;
      const rendered = renderEmail({
        title: "Verify your email",
        paragraphs: ["Confirm this address so Bizora can reach you about your workspace. You can keep using Bizora before you confirm."],
        actionLabel: "Verify email",
        actionUrl: link,
      });
      await this.email.send({ to: address, subject: "Verify your Bizora email", ...rendered });
    } catch (error) {
      this.logger.error({ userId, err: error }, "verification email was not sent");
    }
  }

  async resendVerification(userId: string): Promise<typeof accepted> {
    const user = await this.findUser(userId);
    if (user?.email && !user.emailVerifiedAt) await this.sendVerification(user.id, user.email);
    return accepted;
  }

  async confirmVerification(raw: unknown, meta: AuthMeta): Promise<typeof accepted> {
    const payload = verifyEmailSchema.parse(raw);
    const userId = await this.tokens.consume(payload.token, "verify_email");
    if (!userId) {
      throw new ApiError("VERIFICATION_INVALID", "That verification link is invalid or has expired.", 400);
    }
    await this.db.update(users).set({ emailVerifiedAt: new Date(), updatedBy: userId }).where(eq(users.id, userId));
    await this.audit.record({
      actorUserId: userId,
      action: "identity.email_verified",
      entityType: "user",
      entityId: userId,
      correlationId: meta.correlationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return accepted;
  }

  async requestPasswordReset(raw: unknown): Promise<typeof accepted> {
    const payload = forgotPasswordSchema.parse(raw);
    const email = payload.email.toLowerCase();
    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user?.email || user.kind !== "person") return accepted;
    try {
      const token = await this.tokens.issue(user.id, "password_reset", resetTtlMs);
      const link = `${publicWebOrigin(this.env)}/reset-password?token=${encodeURIComponent(token)}`;
      const rendered = renderEmail({
        title: "Reset your password",
        paragraphs: ["This link expires in 30 minutes and can be used once. If you did not ask for a reset, you can ignore this email."],
        actionLabel: "Choose a new password",
        actionUrl: link,
      });
      await this.email.send({ to: user.email, subject: "Reset your Bizora password", ...rendered });
    } catch (error) {
      this.logger.error({ userId: user.id, err: error }, "password reset email was not sent");
    }
    return accepted;
  }

  async resetPassword(raw: unknown, meta: AuthMeta): Promise<typeof accepted> {
    const payload = resetPasswordSchema.parse(raw);
    const passwordHash = await hashPassword(payload.password);
    const userId = await this.db.transaction(async (tx) => {
      const consumed = await this.tokens.consume(payload.token, "password_reset", tx);
      if (!consumed) return null;
      await tx.update(users).set({ passwordHash, updatedBy: consumed }).where(eq(users.id, consumed));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, consumed), isNull(sessions.revokedAt)));
      return consumed;
    });
    if (!userId) {
      throw new ApiError("RESET_INVALID", "That reset link is invalid or has expired.", 400);
    }
    await this.audit.record({
      actorUserId: userId,
      action: "identity.password_reset",
      entityType: "user",
      entityId: userId,
      correlationId: meta.correlationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return accepted;
  }

  private async findUser(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return user ?? null;
  }
}
