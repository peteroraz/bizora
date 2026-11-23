/**
 * Pilot readiness check (pilot readiness, item 2). Prints every gate in docs/PILOT_READINESS_CHECKLIST.md as
 * PASS, FAIL or MANUAL, and exits with 1 when any gate fails.
 *
 *   node --experimental-strip-types scripts/pilot-readiness-check.ts
 *       Checks the repository: documents, migrations, settings that must hold in staging and production,
 *       and the evidence logs (restore drill, device matrix).
 *
 *   node --experimental-strip-types scripts/pilot-readiness-check.ts --url https://bizora-staging.baseportals.app [--write]
 *       Also checks a running environment: health, security headers, signed-out refusals. With --write it signs up
 *       a throwaway business to check that invitation links are not returned and that sign-in limits cannot be
 *       dodged with a forged X-Forwarded-For (security review S-3). Never use --write on production.
 *
 * MANUAL gates cannot be checked by a script (a real Android phone, a backup in Google Cloud). They pass only when
 * their evidence is written down in the file named.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Result = { gate: string; status: "PASS" | "FAIL" | "MANUAL"; detail: string };
const results: Result[] = [];
const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "");
const record = (gate: string, ok: boolean, detail: string) => results.push({ gate, status: ok ? "PASS" : "FAIL", detail });
const manual = (gate: string, detail: string) => results.push({ gate, status: "MANUAL", detail });

function repositoryChecks() {
  const documents = [
    "docs/PILOT_READINESS_STATUS.md",
    "docs/PILOT_READINESS_CHECKLIST.md",
    "docs/PILOT_DEPLOYMENT_RUNBOOK.md",
    "docs/PILOT_SECURITY_REVIEW.md",
    "docs/PILOT_MOBILE_TEST_MATRIX.md",
    "docs/PILOT_READINESS_REPORT.md",
    "docs/PILOT_DEPENDENCY_REVIEW.md",
    "docs/PILOT_PERFORMANCE_BASELINE.md",
    "docs/runbooks/restore.md",
  ];
  for (const document of documents) record(`Document ${document}`, existsSync(join(root, document)), existsSync(join(root, document)) ? "present" : "missing");

  const migrations = readdirSync(join(root, "apps/api/drizzle")).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  const numbers = migrations.map((name) => Number(name.slice(0, 4)));
  const gaps = numbers.filter((value, index) => index > 0 && value !== numbers[index - 1]! + 1);
  record("Migrations numbered in order, none twice", gaps.length === 0 && new Set(numbers).size === numbers.length, `${migrations.length} migrations, last ${migrations.at(-1)}`);

  const deploy = read(".github/workflows/deploy.yml");
  record("Deploy switches invitation links off (INVITE_TOKEN_EXPOSE=false)", /INVITE_TOKEN_EXPOSE=false/.test(deploy), "set by the deploy workflow (PR #44)");
  const tfvars = read("infra/terraform/envs/staging/terraform.tfvars");
  record("Staging Terraform does not expose invitation links", !/invite_token_expose\s*=\s*true/.test(tfvars), "infra/terraform/envs/staging/terraform.tfvars");
  const env = read("packages/config/src/env.ts");
  record("Production refuses the console email provider", /NODE_ENV === "production" && value\.EMAIL_PROVIDER === "console"/.test(env), "packages/config/src/env.ts (PR #44)");

  const features = read("packages/contracts/src/features.ts");
  record("Payment gateways locked off", /LOCKED_OFF_FEATURES[^\n]*payment_gateways/.test(features), "packages/contracts/src/features.ts (PR #46)");
  record("Tenant isolation matrix in the test suite", existsSync(join(root, "apps/api/src/tenant-matrix.test.ts")), "apps/api/src/tenant-matrix.test.ts (PR #44)");
  record("Financial integrity suite in the test suite", existsSync(join(root, "apps/api/src/financial-integrity.test.ts")), "apps/api/src/financial-integrity.test.ts (PR #44)");
  record("Offline hardening browser tests", existsSync(join(root, "apps/web/e2e/offline-hardening.e2e.ts")), "apps/web/e2e/offline-hardening.e2e.ts (PR #45)");

  const tests = [...walk(join(root, "apps")), ...walk(join(root, "packages"))].filter((file) => /\.(test|e2e)\.ts$/.test(file));
  const focused = tests.filter((file) => /\b(it|test|describe)\.only\(/.test(readFileSync(file, "utf8")));
  record("No focused tests (.only)", focused.length === 0, focused.length ? focused.join(", ") : `${tests.length} test files`);

  // Evidence that only people can produce.
  const restore = read("docs/runbooks/restore.md");
  const drillLog = restore.slice(Math.max(0, restore.indexOf("### Drill log")));
  const drills = drillLog.split("\n").filter((line) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(line));
  record("Restore drill run and logged (docs/runbooks/restore.md)", drills.length > 0, drills.length ? `${drills.length} drill(s), last: ${drills.at(-1)}` : "the drill log is empty");
  const matrix = read("docs/PILOT_MOBILE_TEST_MATRIX.md");
  // Results rows: | Phone | Android / browser | Installed app | Flows passed | … |, with every flow passed ("11/11").
  const results = matrix.slice(Math.max(0, matrix.indexOf("## Results")));
  const devices = results.split("\n").filter((line) => {
    const cells = line.split("|").map((cell) => cell.trim());
    const passed = /^(\d+)\s*(?:\/|of)\s*(\d+)$/.exec(cells[4] ?? "");
    return Boolean(cells[1]) && passed !== null && passed[1] === passed[2];
  });
  record("Android phones tried by hand (docs/PILOT_MOBILE_TEST_MATRIX.md, Results)", devices.length >= 3, `${devices.length} phone(s) with every flow passed; 3 or more needed`);
  manual("Daily backups and point-in-time recovery seen in Google Cloud", "gcloud sql instances describe bizora-pg --format='value(settings.backupConfiguration)'; record it in the runbook");
  manual("Email delivered to a real inbox from staging (verify, reset, invitation)", "docs/PILOT_DEPLOYMENT_RUNBOOK.md, step 6");
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

async function liveChecks(base: string, write: boolean) {
  const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { redirect: "manual", ...init });
  const health = await get("/health").catch(() => null);
  record("Health answers", health?.status === 200, `${health?.status ?? "no answer"}`);
  const home = await get("/").catch(() => null);
  const headers = home?.headers;
  record("HTTPS only (Strict-Transport-Security)", Boolean(headers?.get("strict-transport-security")), headers?.get("strict-transport-security") ?? "missing");
  record("Content security policy, no framing", /frame-ancestors 'none'/.test(headers?.get("content-security-policy") ?? ""), "content-security-policy");
  record("No content-type guessing", headers?.get("x-content-type-options") === "nosniff", headers?.get("x-content-type-options") ?? "missing");
  for (const path of ["/api/v1/auth/me", "/api/v1/exports/business", "/api/v1/sales"]) {
    const response = await get(path).catch(() => null);
    record(`Signed out: ${path} refused`, response?.status === 401, `${response?.status ?? "no answer"}`);
  }
  if (!write) {
    manual("Invitation links not returned, sign-in limits not dodged (needs --write)", "run again with --write against staging");
    return;
  }
  const stamp = Date.now();
  const json = { "content-type": "application/json" };
  const registered = await get("/api/v1/auth/register", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email: `readiness-${stamp}@example.com`, password: `Ready-${stamp}-Check!`, displayName: "Readiness Check", organizationName: `Readiness check ${stamp}`, countryCode: "NG", baseCurrencyCode: "NGN", timezone: "Africa/Lagos", industryCode: "general-retail", acceptTerms: true }),
  });
  const body = (await registered.json().catch(() => ({}))) as { data?: { accessToken?: string; tenant?: { businessId: string; branchId: string } } };
  record("Sign-up works", registered.status === 201, `${registered.status}`);
  if (body.data?.accessToken && body.data.tenant) {
    const invited = await get("/api/v1/invitations", {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${body.data.accessToken}` },
      body: JSON.stringify({ email: `readiness-staff-${stamp}@example.com`, role: "CASHIER", businessId: body.data.tenant.businessId, branchId: body.data.tenant.branchId }),
    });
    const invitation = ((await invited.json().catch(() => ({}))) as { data?: { invitation?: Record<string, unknown> } }).data?.invitation ?? {};
    record("Invitation link is not returned by the API", invited.status === 201 && !("token" in invitation), `status ${invited.status}, token ${"token" in invitation ? "RETURNED" : "not returned"}`);
  }
  // S-3: the limit must count the person's real address. A forged X-Forwarded-For must not give a fresh allowance.
  let limited = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await get("/api/v1/auth/login", { method: "POST", headers: { ...json, "x-forwarded-for": `203.0.113.${attempt}` }, body: JSON.stringify({ email: `nobody-${stamp}@example.com`, password: "wrong-password-1" }) });
    if (response.status === 429) limited += 1;
  }
  record("Sign-in limit holds against forged X-Forwarded-For (S-3)", limited > 0, limited ? `${limited} of 30 attempts limited` : "30 wrong passwords, each with a different forged address, and none was limited");
}

const args = process.argv.slice(2);
const at = args.indexOf("--url");
repositoryChecks();
if (at >= 0) await liveChecks(String(args[at + 1]).replace(/\/$/, ""), args.includes("--write"));

const width = Math.max(...results.map((result) => result.gate.length));
for (const result of results) console.log(`${result.status.padEnd(6)} ${result.gate.padEnd(width)}  ${result.detail}`);
const failed = results.filter((result) => result.status === "FAIL").length;
const manualCount = results.filter((result) => result.status === "MANUAL").length;
console.log(`\n${results.length - failed - manualCount} passed, ${failed} failed, ${manualCount} to check by hand.`);
process.exit(failed > 0 ? 1 : 0);
