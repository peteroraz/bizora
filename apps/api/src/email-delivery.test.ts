import { loadEnv } from "@bizora/config/env";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConsoleEmailAdapter } from "./modules/email/console-email.adapter.js";
import { hideTokens, maskEmail } from "./modules/email/email.port.js";
import { ResendEmailAdapter } from "./modules/email/resend-email.adapter.js";
import { auth, boot, password, product, shop, testEnv, type Harness } from "./test-support.js";

// ADR-042: email delivery before the pilot.

function fakeLogger() {
  const lines: string[] = [];
  const write = (object: unknown, message?: string) => void lines.push(JSON.stringify(object) + (message ?? ""));
  return { lines, logger: { info: write, warn: write, error: write } as never };
}

const message = { to: "ngozi@shop.ng", subject: "Reset", html: "<a href='https://bizora.app/reset-password?token=SECRET123'>x</a>", text: "Open https://bizora.app/reset-password?token=SECRET123", kind: "password_reset" as const };

describe("email provider", () => {
  it("tries again when the provider is busy, with one idempotency key, and never logs the token or full address", async () => {
    const { lines, logger } = fakeLogger();
    const keys: string[] = [];
    const post = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        keys.push((init.headers as Record<string, string>)["idempotency-key"]!);
        return new Response("busy", { status: 503 });
      })
      .mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        keys.push((init.headers as Record<string, string>)["idempotency-key"]!);
        return new Response("{}", { status: 200 });
      });
    const adapter = new ResendEmailAdapter("re_key", "Bizora <no-reply@bizora.app>", logger, async () => undefined, post as never);
    await adapter.send(message);
    expect(post).toHaveBeenCalledTimes(3);
    expect(new Set(keys).size).toBe(1);
    const logged = lines.join("\n");
    expect(logged).not.toContain("SECRET123");
    expect(logged).not.toContain("ngozi@shop.ng");
    expect(logged).toContain("n***@shop.ng");
    expect(logged).not.toContain("re_key");
  });

  it("does not retry a message the provider refuses, and reports the failure", async () => {
    const { logger } = fakeLogger();
    const post = vi.fn(async () => new Response("bad", { status: 422 }));
    const adapter = new ResendEmailAdapter("re_key", "Bizora <no-reply@bizora.app>", logger, async () => undefined, post as never);
    await expect(adapter.send(message)).rejects.toThrow("Email could not be sent.");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("gives up after three tries", async () => {
    const { logger } = fakeLogger();
    const post = vi.fn(async () => new Response("busy", { status: 429 }));
    const adapter = new ResendEmailAdapter("re_key", "Bizora <no-reply@bizora.app>", logger, async () => undefined, post as never);
    await expect(adapter.send(message)).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("hides tokens in the console provider's log outside local development", async () => {
    const { lines, logger } = fakeLogger();
    await new ConsoleEmailAdapter(logger).send(message);
    expect(lines.join("")).not.toContain("SECRET123");
    expect(hideTokens("https://x.app/shop/r/AbCdEfGhIjKlMnOpQrStUvWx and ?code=zz")).toBe("https://x.app/shop/r/[hidden] and ?code=[hidden]");
    expect(maskEmail("ada@x.ng")).toBe("a***@x.ng");
  });
});

describe("production settings", () => {
  const base = { NODE_ENV: "production", DATABASE_URL: "postgres://u:p@h:5432/d", JWT_SECRET: "x".repeat(40), WEB_ORIGIN: "https://bizora.app" };
  it("refuses to start without a real email provider, or with invitation tokens returned by the API", () => {
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: "console" })).toThrow(/EMAIL_PROVIDER/);
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "re_x", EMAIL_FROM: "Bizora <no-reply@bizora.app>", INVITE_TOKEN_EXPOSE: "true" })).toThrow(/INVITE_TOKEN_EXPOSE/);
    expect(loadEnv({ ...base, EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "re_x", EMAIL_FROM: "Bizora <no-reply@bizora.app>" }).INVITE_TOKEN_EXPOSE).toBe(false);
  });
});

describe("emails real businesses receive", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot(testEnv({ INVITE_TOKEN_EXPOSE: false }));
  });
  afterAll(async () => h.close());

  const linkIn = (text: string) => new URL(text.match(/https?:\/\/\S+/)?.[0] ?? "http://localhost/missing");

  it("sends the invitation link by email only; the API never returns the token", async () => {
    const owner = await shop(h.http, "owner@mail.test", "Ada Stores");
    const invited = await request(h.http).post("/api/v1/invitations").set(auth(owner.token)).send({ email: "cashier@mail.test", role: "CASHIER", businessId: owner.businessId, branchId: owner.branchId }).expect(201);
    expect(invited.body.data.invitation.token).toBeUndefined();
    expect(JSON.stringify(invited.body)).not.toMatch(/invite\?token=/);
    const mail = h.email.delivered.find((sent) => sent.to === "cashier@mail.test");
    expect(mail?.kind).toBe("invitation");
    const token = linkIn(mail!.text).searchParams.get("token");
    await request(h.http).post("/api/v1/invitations/accept").send({ token, displayName: "Bimpe", password }).expect(201);
  });

  it("refuses a made-up reset link, and tells the person when their password changes", async () => {
    const invalid = await request(h.http).post("/api/v1/auth/password/reset").send({ token: "not-a-real-token-at-all-1234567890", password: "LocalOnly!Reset9" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("RESET_INVALID");
    await request(h.http).post("/api/v1/auth/password/forgot").send({ email: "owner@mail.test" }).expect(201);
    const reset = [...h.email.delivered].reverse().find((sent) => sent.kind === "password_reset" && sent.to === "owner@mail.test");
    await request(h.http).post("/api/v1/auth/password/reset").send({ token: linkIn(reset!.text).searchParams.get("token"), password: "LocalOnly!Reset9" }).expect(201);
    const notice = [...h.email.delivered].reverse().find((sent) => sent.to === "owner@mail.test");
    expect(notice?.kind).toBe("password_changed");
    expect(notice?.text).toContain("signed out on every phone");
    expect(notice?.text).not.toMatch(/token=/);
  });

  it("emails a customer their receipt link; only someone in the business can, and the address is not kept", async () => {
    const owner = await shop(h.http, "seller@mail.test", "Chidi Foods");
    const rice = await product(h.http, owner.token, "Rice 50kg", "7500000");
    const sale = await request(h.http).post("/api/v1/sales").set(auth(owner.token)).set("idempotency-key", randomUUID()).send({ lines: [{ productId: rice, quantity: "1", unit: "bag" }], payments: [{ method: "cash", amountMinor: "7500000" }] }).expect(201);
    const id = sale.body.data.sale.id as string;
    await request(h.http).post(`/api/v1/sales/${id}/email`).set(auth(owner.token)).send({ to: "not an email" }).expect(400);
    await request(h.http).post(`/api/v1/sales/${id}/email`).set(auth(owner.token)).send({ to: "Buyer@Gmail.com" }).expect(200);
    const mail = h.email.delivered.at(-1)!;
    expect(mail).toMatchObject({ to: "buyer@gmail.com", kind: "receipt" });
    expect(mail.text).toMatch(/\/r\/[A-Za-z0-9_-]{20,}/);
    const audit = await h.client.query<{ metadata_json: string }>("SELECT metadata_json FROM audit_events WHERE action = 'sale.receipt_emailed' AND entity_id = $1", [id]);
    expect(audit.rows.map((row) => JSON.parse(row.metadata_json))).toEqual([{ toDomain: "gmail.com" }]);
    // Another business cannot send it.
    const other = await shop(h.http, "other@mail.test", "Other Shop");
    await request(h.http).post(`/api/v1/sales/${id}/email`).set(auth(other.token)).send({ to: "x@y.ng" }).expect(404);
  });
});

describe("password reset requests are limited", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot(testEnv({ THROTTLE_AUTH_LIMIT: 3 }));
  });
  afterAll(async () => h.close());

  it("answers the same for every address until the limit, then refuses", async () => {
    const answers: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      answers.push((await request(h.http).post("/api/v1/auth/password/forgot").send({ email: `someone${attempt}@mail.test` })).status);
    }
    expect(answers.slice(0, 3)).toEqual([201, 201, 201]);
    expect(answers.slice(3)).toEqual([429, 429]);
  });
});
