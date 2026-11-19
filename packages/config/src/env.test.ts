import { describe, expect, it } from "vitest";
import { loadEnv, socketDirFromEnv } from "./env.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://bizora:bizora@localhost:5432/bizora",
  JWT_SECRET: "test-secret-must-be-at-least-32-chars",
};

describe("DATABASE_SOCKET_DIR", () => {
  it("stays unset for local development", () => {
    expect(loadEnv(base).DATABASE_SOCKET_DIR).toBeUndefined();
    expect(loadEnv({ ...base, DATABASE_SOCKET_DIR: "" }).DATABASE_SOCKET_DIR).toBeUndefined();
    expect(socketDirFromEnv(undefined)).toBeUndefined();
  });

  it("accepts an absolute Cloud SQL socket directory", () => {
    const socketDir = "/cloudsql/bizora-staging:europe-west1:bizora-pg";
    expect(loadEnv({ ...base, DATABASE_SOCKET_DIR: socketDir }).DATABASE_SOCKET_DIR).toBe(socketDir);
    expect(socketDirFromEnv(socketDir)).toBe(socketDir);
  });

  it("keeps email and OAuth off until both halves of a provider are configured", () => {
    expect(loadEnv(base).EMAIL_PROVIDER).toBe("console");
    expect(loadEnv(base).GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(loadEnv({ ...base, GOOGLE_OAUTH_CLIENT_ID: "" }).GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: "resend" })).toThrow(/EMAIL_API_KEY/);
    expect(() => loadEnv({ ...base, GOOGLE_OAUTH_CLIENT_ID: "google-client" })).toThrow(/client id and secret/);
    expect(
      loadEnv({
        ...base,
        EMAIL_PROVIDER: "resend",
        EMAIL_API_KEY: "re_test",
        EMAIL_FROM: "Bizora <hello@bizora.test>",
        GOOGLE_OAUTH_CLIENT_ID: "google-client",
        GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
      }).EMAIL_FROM,
    ).toBe("Bizora <hello@bizora.test>");
  });

  it("rejects a relative path", () => {
    expect(() => loadEnv({ ...base, DATABASE_SOCKET_DIR: "cloudsql/instance" })).toThrow(/absolute path/);
    expect(() => socketDirFromEnv("cloudsql/instance")).toThrow(/absolute path/);
  });
});

describe("AI capture settings", () => {
  it("is off by default, needs a project for Vertex AI, and never uses the fake model in production", () => {
    expect(loadEnv(base)).toMatchObject({ AI_PROVIDER: "off", VERTEX_LOCATION: "global", VERTEX_MODEL: "gemini-3.8-flash", AI_DAILY_CAPTURE_LIMIT: 100 });
    expect(() => loadEnv({ ...base, AI_PROVIDER: "vertex" })).toThrow("VERTEX_PROJECT");
    expect(loadEnv({ ...base, AI_PROVIDER: "vertex", VERTEX_PROJECT: "bizora-staging", AI_DAILY_CAPTURE_LIMIT: "10" })).toMatchObject({ VERTEX_PROJECT: "bizora-staging", AI_DAILY_CAPTURE_LIMIT: 10 });
    expect(() => loadEnv({ ...base, NODE_ENV: "production", AI_PROVIDER: "fake" })).toThrow("fake is for tests only");
  });
});
