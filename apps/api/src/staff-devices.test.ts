import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "@bizora/config/env";
import type { INestApplication } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./bootstrap.js";
import { auditEvents, organizationPlans, schema, sessions, staffPinAttempts } from "./db/schema.js";
import { loadMigrationSql } from "./db/sql.js";
import { createLogger } from "./logging.js";

const env: AppEnv = {
  NODE_ENV: "test",
  API_PORT: 3001,
  LOG_LEVEL: "error",
  DATABASE_URL: "postgres://bizora:bizora@localhost:5432/bizora_test",
  JWT_SECRET: "test-secret-must-be-at-least-32-chars",
  JWT_ACCESS_TTL: "1h",
  JWT_REFRESH_TTL: "7d",
  WEB_ORIGIN: "http://localhost:3000",
  COOKIE_SECURE: false,
  COOKIE_SAMESITE: "lax",
  THROTTLE_TTL_MS: 60_000,
  THROTTLE_AUTH_LIMIT: 1000,
  INVITE_TOKEN_EXPOSE: true,
  TRUST_PROXY: false,
};

const password = "LocalOnly!Passw0rd";
type Http = Parameters<typeof request>[0];

function cookieValue(response: request.Response, name: string): string {
  const header = response.headers["set-cookie"] as unknown as string[] | undefined;
  const match = (header ?? []).find((cookie) => cookie.startsWith(`${name}=`));
  if (!match) throw new Error(`cookie ${name} not set`);
  return decodeURIComponent(match.slice(name.length + 1).split(";")[0] ?? "");
}

async function register(http: Http, email: string, organizationName: string) {
  const response = await request(http)
    .post("/api/v1/auth/register")
    .send({
      email,
      password,
      displayName: organizationName,
      organizationName,
      countryCode: "NG",
      baseCurrencyCode: "NGN",
      timezone: "Africa/Lagos",
    })
    .expect(201);
  return {
    token: response.body.data.accessToken as string,
    tenantId: response.body.data.tenant.tenantId as string,
    businessId: response.body.data.tenant.businessId as string,
    branchId: response.body.data.tenant.branchId as string,
  };
}

describe("staff PIN on shop devices, roles and plans (Sprint 3C.5a)", () => {
  let app: INestApplication;
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let http: Http;
  let owner: Awaited<ReturnType<typeof register>>;
  let other: Awaited<ReturnType<typeof register>>;
  let deviceToken = "";
  let deviceId = "";
  let chikaId = "";
  let emekaId = "";

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const deviceCookie = (token = deviceToken) => `bizora_device=${encodeURIComponent(token)}`;

  function pinLogin(staffId: string, pin: string, device = deviceToken) {
    return request(http).post("/api/v1/shop/pin-login").set("Cookie", deviceCookie(device)).send({ staffId, pin });
  }

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    owner = await register(http, "owner@staff.test", "Ada Stores");
    other = await register(http, "owner@other-staff.test", "Other Stores");
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("puts new workspaces on the starter plan and enforces the branch limit", async () => {
    const plan = await request(http).get("/api/v1/plan").set(bearer(owner.token)).expect(200);
    expect(plan.body.data.plan.code).toBe("starter");
    expect(plan.body.data.limits).toMatchObject({ max_branches: 1, max_staff: 2, max_devices: 2 });
    expect(plan.body.data.usage.max_branches).toBe(1);

    const blocked = await request(http)
      .post("/api/v1/branches")
      .set(bearer(owner.token))
      .send({ name: "Second shop", businessId: owner.businessId })
      .expect(402);
    expect(blocked.body.error.code).toBe("PLAN_LIMIT");
    expect(blocked.body.error.message).toMatch(/Upgrade/);
  });

  it("adds the new permissions to the right roles", async () => {
    const me = await request(http).get("/api/v1/auth/me").set(bearer(owner.token)).expect(200);
    expect(me.body.data.tenant.permissions).toEqual(
      expect.arrayContaining(["prices.cost.read", "reports.profit.read", "staff.manage", "devices.manage"]),
    );
  });

  it("creates staff without email and rejects weak PINs, unknown roles and other tenants' branches", async () => {
    await request(http)
      .post("/api/v1/staff")
      .set(bearer(owner.token))
      .send({ displayName: "Weak", role: "SALES", branchId: owner.branchId, pin: "1234" })
      .expect(400);
    await request(http)
      .post("/api/v1/staff")
      .set(bearer(owner.token))
      .send({ displayName: "Boss", role: "OWNER", branchId: owner.branchId, pin: "4821" })
      .expect(400);
    await request(http)
      .post("/api/v1/staff")
      .set(bearer(owner.token))
      .send({ displayName: "Sneaky", role: "SALES", branchId: other.branchId, pin: "4821" })
      .expect(403);

    const chika = await request(http)
      .post("/api/v1/staff")
      .set(bearer(owner.token))
      .send({ displayName: "Chika", role: "SALES", branchId: owner.branchId, phoneE164: "+2348031234567", pin: "4821" })
      .expect(201);
    chikaId = chika.body.data.staff.id as string;
    expect(chika.body.data.staff).toMatchObject({ displayName: "Chika", role: "SALES", status: "active" });

    const emeka = await request(http)
      .post("/api/v1/staff")
      .set(bearer(owner.token))
      .send({ displayName: "Emeka", role: "INVENTORY", branchId: owner.branchId, pin: "7395" })
      .expect(201);
    emekaId = emeka.body.data.staff.id as string;

    // Starter allows 2 staff: a third (PIN staff or invitation) is refused.
    const third = await request(http)
      .post("/api/v1/staff")
      .set(bearer(owner.token))
      .send({ displayName: "Third", role: "SALES", branchId: owner.branchId, pin: "5068" })
      .expect(402);
    expect(third.body.error.code).toBe("PLAN_LIMIT");
    await request(http)
      .post("/api/v1/invitations")
      .set(bearer(owner.token))
      .send({ email: "extra@staff.test", role: "SALES" })
      .expect(402);

    const list = await request(http).get("/api/v1/staff").set(bearer(owner.token)).expect(200);
    expect(list.body.data.items.map((item: { displayName: string }) => item.displayName)).toEqual(["Chika", "Emeka"]);
    const otherList = await request(http).get("/api/v1/staff").set(bearer(other.token)).expect(200);
    expect(otherList.body.data.items).toEqual([]);
  });

  it("enrolls a shop device with an httpOnly cookie and lists the branch staff", async () => {
    const enrolled = await request(http)
      .post("/api/v1/shop-devices")
      .set(bearer(owner.token))
      .send({ name: "Counter phone" })
      .expect(201);
    deviceId = enrolled.body.data.device.id as string;
    deviceToken = cookieValue(enrolled, "bizora_device");
    const raw = (enrolled.headers["set-cookie"] as unknown as string[]).find((cookie) => cookie.startsWith("bizora_device="));
    expect(raw).toMatch(/HttpOnly/i);
    expect(JSON.stringify(enrolled.body)).not.toContain(deviceToken);

    const shop = await request(http).get("/api/v1/shop/device").set("Cookie", deviceCookie()).expect(200);
    expect(shop.body.data.staff.map((item: { displayName: string }) => item.displayName)).toEqual(["Chika", "Emeka"]);
    expect(shop.body.data.branchName).toBeTruthy();

    await request(http).get("/api/v1/shop/device").expect(401);
    await request(http).get("/api/v1/shop/device").set("Cookie", deviceCookie("not-a-real-device-token")).expect(401);
  });

  it("never accepts a PIN without a valid device cookie", async () => {
    await request(http).post("/api/v1/shop/pin-login").send({ staffId: chikaId, pin: "4821" }).expect(401);
    await pinLogin(chikaId, "4821", "forged-device-token").expect(401);

    // A device enrolled by another tenant cannot sign in this tenant's staff.
    const otherDevice = await request(http)
      .post("/api/v1/shop-devices")
      .set(bearer(other.token))
      .send({ name: "Other counter" })
      .expect(201);
    const otherDeviceToken = cookieValue(otherDevice, "bizora_device");
    const crossTenant = await pinLogin(chikaId, "4821", otherDeviceToken).expect(401);
    expect(crossTenant.body.error.code).toBe("INVALID_PIN");
  });

  it("signs staff in with the PIN and binds the session to the device", async () => {
    const login = await pinLogin(chikaId, "4821").expect(201);
    const session = cookieValue(login, "bizora_session");
    const refresh = cookieValue(login, "bizora_refresh");

    const me = await request(http)
      .get("/api/v1/auth/me")
      .set("Cookie", `${deviceCookie()}; bizora_session=${session}`)
      .expect(200);
    expect(me.body.data.tenant.role).toBe("SALES");
    expect(me.body.data.tenant.deviceId).toBe(deviceId);
    expect(me.body.data.tenant.branchId).toBe(owner.branchId);
    expect(me.body.data.tenant.permissions).not.toContain("prices.cost.read");
    expect(me.body.data.tenant.permissions).not.toContain("reports.profit.read");
    expect(me.body.data.user.kind).toBe("staff");
    expect(me.body.data.user.email).toBeNull();

    // The same session without the device cookie (e.g. copied to another browser) is rejected.
    await request(http).get("/api/v1/auth/me").set("Cookie", `bizora_session=${session}`).expect(401);
    await request(http).get("/api/v1/auth/me").set(bearer(session)).expect(401);
    // Refresh also needs the device.
    await request(http).post("/api/v1/auth/refresh").send({ refreshToken: refresh }).expect(401);

    // Staff sessions cannot manage staff, enrol devices, switch workspace, or set a password.
    const cookie = `${deviceCookie()}; bizora_session=${session}`;
    await request(http).get("/api/v1/staff").set("Cookie", cookie).expect(403);
    await request(http).post("/api/v1/shop-devices").set("Cookie", cookie).send({ name: "x" }).expect(403);
    await request(http)
      .post("/api/v1/auth/select-context")
      .set("Cookie", cookie)
      .send({ organizationId: owner.tenantId })
      .expect(403);
    await request(http)
      .post("/api/v1/auth/password")
      .set("Cookie", cookie)
      .send({ newPassword: "NewLocalOnly!Passw0rd2" })
      .expect(403);

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "identity.login"), eq(auditEvents.actorType, "STAFF_PIN")))
      .limit(1);
    expect(audit?.tenantId).toBe(owner.tenantId);
  });

  it("locks a staff member on the device after 5 wrong PINs, then unlocks after 15 minutes", async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const wrong = await pinLogin(emekaId, "1111").expect(401);
      expect(wrong.body.error.code).toBe("INVALID_PIN");
    }
    const fifth = await pinLogin(emekaId, "1111").expect(423);
    expect(fifth.body.error.code).toBe("STAFF_LOCKED");
    // Even the right PIN is refused while locked.
    const locked = await pinLogin(emekaId, "7395").expect(423);
    expect(locked.body.error.code).toBe("STAFF_LOCKED");
    const roster = await request(http).get("/api/v1/shop/device").set("Cookie", deviceCookie()).expect(200);
    const emeka = roster.body.data.staff.find((item: { id: string }) => item.id === emekaId);
    expect(emeka.lockedUntil).toBeTruthy();
    // Chika is not affected by Emeka's lock.
    await pinLogin(chikaId, "4821").expect(201);

    await db
      .update(staffPinAttempts)
      .set({ createdAt: sql`created_at - interval '16 minutes'` })
      .where(eq(staffPinAttempts.membershipId, emekaId));
    await pinLogin(emekaId, "7395").expect(201);
  });

  it("suspends the device after 20 failures in 24 hours, ends its sessions, and lets the owner re-approve it", async () => {
    const live = await pinLogin(chikaId, "4821").expect(201);
    const liveSession = cookieValue(live, "bizora_session");

    let last: request.Response | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      // Alternate staff and unknown ids so the per-staff lock does not stop the count.
      const target = attempt % 3 === 0 ? "00000000-0000-4000-8000-000000000000" : attempt % 3 === 1 ? chikaId : emekaId;
      last = await pinLogin(target, "1111");
      if (last.status === 423 && last.body.error.code === "DEVICE_SUSPENDED") break;
    }
    expect(last?.body.error.code).toBe("DEVICE_SUSPENDED");
    await request(http).get("/api/v1/shop/device").set("Cookie", deviceCookie()).expect(423);
    await request(http)
      .get("/api/v1/auth/me")
      .set("Cookie", `${deviceCookie()}; bizora_session=${liveSession}`)
      .expect(401);
    const suspended = await request(http).get("/api/v1/shop-devices").set(bearer(owner.token)).expect(200);
    expect(suspended.body.data.items.find((item: { id: string }) => item.id === deviceId).status).toBe("suspended");

    // Another tenant cannot approve it.
    await request(http).post(`/api/v1/shop-devices/${deviceId}/approve`).set(bearer(other.token)).expect(404);
    await request(http).post(`/api/v1/shop-devices/${deviceId}/approve`).set(bearer(owner.token)).expect(201);
    // Reset the per-staff windows too, then sign in again.
    await db.update(staffPinAttempts).set({ createdAt: sql`created_at - interval '16 minutes'` });
    await pinLogin(chikaId, "4821").expect(201);
  });

  it("resetting a PIN, deactivating staff and revoking the device end sessions immediately", async () => {
    const first = await pinLogin(chikaId, "4821").expect(201);
    const firstCookie = `${deviceCookie()}; bizora_session=${cookieValue(first, "bizora_session")}`;
    await request(http).get("/api/v1/auth/me").set("Cookie", firstCookie).expect(200);

    await request(http).post(`/api/v1/staff/${chikaId}/pin`).set(bearer(owner.token)).send({ pin: "6047" }).expect(201);
    await request(http).get("/api/v1/auth/me").set("Cookie", firstCookie).expect(401);
    await pinLogin(chikaId, "4821").expect(401);
    const second = await pinLogin(chikaId, "6047").expect(201);
    const secondCookie = `${deviceCookie()}; bizora_session=${cookieValue(second, "bizora_session")}`;

    await request(http).post(`/api/v1/staff/${chikaId}/deactivate`).set(bearer(owner.token)).expect(201);
    await request(http).get("/api/v1/auth/me").set("Cookie", secondCookie).expect(401);
    await pinLogin(chikaId, "6047").expect(401);
    await request(http).post(`/api/v1/staff/${chikaId}/reactivate`).set(bearer(owner.token)).expect(201);

    const third = await pinLogin(chikaId, "6047").expect(201);
    const thirdCookie = `${deviceCookie()}; bizora_session=${cookieValue(third, "bizora_session")}`;
    // Another tenant cannot touch this tenant's staff or devices.
    await request(http).post(`/api/v1/staff/${chikaId}/deactivate`).set(bearer(other.token)).expect(404);
    await request(http).post(`/api/v1/shop-devices/${deviceId}/revoke`).set(bearer(other.token)).expect(404);

    await request(http).post(`/api/v1/shop-devices/${deviceId}/revoke`).set(bearer(owner.token)).expect(201);
    await request(http).get("/api/v1/auth/me").set("Cookie", thirdCookie).expect(401);
    await pinLogin(chikaId, "6047").expect(401);
    await request(http).get("/api/v1/shop/device").set("Cookie", deviceCookie()).expect(401);
    const live = await db.select().from(sessions).where(eq(sessions.deviceId, deviceId));
    expect(live.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("enforces the device limit, frees a slot on revoke, and exits Shop mode on the current device", async () => {
    // Owner: 1 device revoked above; "other" tenant has its own. Starter allows 2 active devices.
    const a = await request(http).post("/api/v1/shop-devices").set(bearer(owner.token)).send({ name: "A" }).expect(201);
    await request(http).post("/api/v1/shop-devices").set(bearer(owner.token)).send({ name: "B" }).expect(201);
    const blocked = await request(http)
      .post("/api/v1/shop-devices")
      .set(bearer(owner.token))
      .send({ name: "C" })
      .expect(402);
    expect(blocked.body.error.code).toBe("PLAN_LIMIT");

    const aToken = cookieValue(a, "bizora_device");
    const exit = await request(http)
      .post("/api/v1/shop-devices/current/exit")
      .set("Cookie", `${deviceCookie(aToken)}`)
      .set(bearer(owner.token))
      .expect(201);
    expect(exit.body.data.device.status).toBe("revoked");
    await request(http).post("/api/v1/shop-devices").set(bearer(owner.token)).send({ name: "C" }).expect(201);
  });

  it("limits a branch-scoped manager to their own branch", async () => {
    await db.update(organizationPlans).set({ planCode: "business" }).where(eq(organizationPlans.tenantId, owner.tenantId));
    const second = await request(http)
      .post("/api/v1/branches")
      .set(bearer(owner.token))
      .send({ name: "Onitsha", businessId: owner.businessId })
      .expect(201);
    const onitshaId = second.body.data.branch.id as string;
    const invited = await request(http)
      .post("/api/v1/invitations")
      .set(bearer(owner.token))
      .send({ email: "manager@staff.test", role: "MANAGER", businessId: owner.businessId, branchId: onitshaId })
      .expect(201);
    await request(http)
      .post("/api/v1/invitations/accept")
      .send({ token: invited.body.data.invitation.token, displayName: "Manager", password })
      .expect(201);
    const login = await request(http)
      .post("/api/v1/auth/login")
      .send({ email: "manager@staff.test", password })
      .expect(201);
    const manager = login.body.data.accessToken as string;

    await request(http)
      .post("/api/v1/staff")
      .set(bearer(manager))
      .send({ displayName: "Main shop", role: "SALES", branchId: owner.branchId, pin: "2580" })
      .expect(403);
    await request(http)
      .post("/api/v1/staff")
      .set(bearer(manager))
      .send({ displayName: "Ngozi", role: "SALES", branchId: onitshaId, pin: "2580" })
      .expect(201);
    const visible = await request(http).get("/api/v1/staff").set(bearer(manager)).expect(200);
    expect(visible.body.data.items.map((item: { displayName: string }) => item.displayName)).toEqual(["Ngozi"]);
    await request(http).post(`/api/v1/staff/${chikaId}/deactivate`).set(bearer(manager)).expect(404);
    const devices = await request(http).get("/api/v1/shop-devices").set(bearer(manager)).expect(200);
    expect(devices.body.data.items).toEqual([]);
  });

  it("staff users cannot use email/password sign-in or password reset", async () => {
    const staffUsers = await client.query<{ email: string | null; password_hash: string | null; kind: string }>(
      "SELECT email, password_hash, kind FROM users WHERE kind = 'staff'",
    );
    expect(staffUsers.rows.length).toBeGreaterThan(0);
    expect(staffUsers.rows.every((row) => row.email === null && row.password_hash === null)).toBe(true);
    // The database itself refuses a staff user with a password.
    await expect(
      client.query("UPDATE users SET password_hash = 'x' WHERE kind = 'staff'"),
    ).rejects.toThrow();
  });
});

describe("customer CSV import limits", () => {
  let app: INestApplication;
  let client: PGlite;
  let http: Http;
  let token = "";

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    for (const migration of await loadMigrationSql()) {
      await client.exec(migration.sql);
    }
    app = await createApp(env, db, createLogger("error"));
    await app.init();
    http = app.getHttpServer();
    token = (await register(http, "csv@staff.test", "CSV Stores")).token;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  function csv(rows: number) {
    const lines = ["name,phone,email,notes"];
    for (let index = 0; index < rows; index += 1) {
      lines.push(
        `Customer ${index},0803${String(1000000 + index).padStart(7, "0")},,Bulk import row ${index} from the Onitsha market ledger`,
      );
    }
    return lines.join("\n");
  }

  it("rejects more than 2,000 rows with a clear message", async () => {
    const response = await request(http)
      .post("/api/v1/customers/import")
      .set("authorization", `Bearer ${token}`)
      .send({ csv: csv(2001), commit: false })
      .expect(400);
    expect(response.body.error.code).toBe("CSV_INVALID");
    expect(response.body.error.message).toContain("2001 rows");
  });

  it("accepts a 2,000-row file (above the default body limit) within the time budget", async () => {
    const body = csv(2000);
    expect(body.length).toBeGreaterThan(100 * 1024);
    const started = Date.now();
    const response = await request(http)
      .post("/api/v1/customers/import")
      .set("authorization", `Bearer ${token}`)
      .send({ csv: body, commit: true })
      .expect(201);
    expect(response.body.data.created).toBe(2000);
    expect(Date.now() - started).toBeLessThan(30_000);

    // Re-import matches on phone: everything is an update now.
    const again = await request(http)
      .post("/api/v1/customers/import")
      .set("authorization", `Bearer ${token}`)
      .send({ csv: csv(3), commit: false })
      .expect(201);
    expect(again.body.data.rows.every((row: { action: string }) => row.action === "update")).toBe(true);
  }, 60_000);

  it("keeps the small default body limit on other routes", async () => {
    await request(http)
      .post("/api/v1/customers")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "Big", phone: "08030000000", notes: "x".repeat(200 * 1024) })
      .expect(413);
  });
});
