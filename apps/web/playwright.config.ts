import { defineConfig, devices } from "@playwright/test";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://bizora:bizora@localhost:5432/bizora";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://localhost:3000", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @bizora/api start",
      url: "http://localhost:3001/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: "development",
        DATABASE_URL: databaseUrl,
        JWT_SECRET: "e2e-secret-must-be-at-least-32-characters",
        WEB_ORIGIN: "http://localhost:3000",
        COOKIE_SECURE: "false",
        INVITE_TOKEN_EXPOSE: "true",
        // AI capture uses canned drafts in tests (ADR-018); the real model is never called.
        AI_PROVIDER: "fake",
        AI_DAILY_CAPTURE_LIMIT: "50",
        THROTTLE_AUTH_LIMIT: "200",
        API_PORT: "3001",
        // CI inherits the runner environment. Pin the Sprint 3C settings so an
        // unset provider stays on the console adapter and OAuth stays hidden.
        EMAIL_PROVIDER: "console",
        EMAIL_API_KEY: "",
        EMAIL_FROM: "",
        PUBLIC_WEB_ORIGIN: "",
        GOOGLE_OAUTH_CLIENT_ID: "",
        GOOGLE_OAUTH_CLIENT_SECRET: "",
      },
    },
    {
      command: "pnpm --filter @bizora/web start",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { API_ORIGIN: "http://localhost:3001" },
    },
  ],
});
