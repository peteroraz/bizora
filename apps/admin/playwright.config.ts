import { defineConfig, devices } from "@playwright/test";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://bizora:bizora@localhost:5432/bizora";

/**
 * The Admin portal on :3002, its own API server on :3021 (with the portal turned on), and a fake Google on :3009.
 * The business app's end-to-end tests use :3000 and :3001, so both suites can run on one machine.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://localhost:3002", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/fake-google.mjs",
      url: "http://127.0.0.1:3009/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @bizora/api start",
      url: "http://localhost:3021/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: "development",
        DATABASE_URL: databaseUrl,
        JWT_SECRET: "e2e-secret-must-be-at-least-32-characters",
        WEB_ORIGIN: "http://localhost:3000",
        COOKIE_SECURE: "false",
        INVITE_TOKEN_EXPOSE: "true",
        AI_PROVIDER: "fake",
        THROTTLE_AUTH_LIMIT: "200",
        API_PORT: "3021",
        EMAIL_PROVIDER: "console",
        EMAIL_API_KEY: "",
        EMAIL_FROM: "",
        PUBLIC_WEB_ORIGIN: "",
        GOOGLE_OAUTH_CLIENT_ID: "e2e-client",
        GOOGLE_OAUTH_CLIENT_SECRET: "e2e-secret",
        GOOGLE_OAUTH_ISSUER: "http://127.0.0.1:3009/",
        ADMIN_WEB_ORIGIN: "http://localhost:3002",
        ADMIN_BOOTSTRAP_EMAILS: "lead@bizora.test",
      },
    },
    {
      // Rewrites are fixed when Next.js builds, so the portal is built here against this suite's API server.
      command: "pnpm --filter @bizora/admin build && pnpm --filter @bizora/admin start",
      url: "http://localhost:3002/robots.txt",
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: { API_ORIGIN: "http://localhost:3021", BIZORA_ENVIRONMENT: "e2e" },
    },
  ],
});
