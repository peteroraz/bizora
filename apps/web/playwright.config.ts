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
        THROTTLE_AUTH_LIMIT: "200",
        API_PORT: "3001",
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
