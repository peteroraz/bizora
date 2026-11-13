import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean().optional());

// Cloud SQL connector sockets look like /cloudsql/PROJECT:REGION:INSTANCE.
// postgres.js appends /.s.PGSQL.5432 when this value is the host option.
const socketDirSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .regex(/^\/(?:[^/\s?]+\/)*[^/\s?]+$/, "must be an absolute path")
    .optional(),
);

export function socketDirFromEnv(value: string | undefined): string | undefined {
  const parsed = socketDirSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid environment configuration: DATABASE_SOCKET_DIR: must be an absolute path");
  }
  return parsed.data;
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SOCKET_DIR: socketDirSchema.optional(),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  COOKIE_SECURE: booleanFromEnv,
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
  THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  THROTTLE_AUTH_LIMIT: z.coerce.number().int().positive().default(20),
  INVITE_TOKEN_EXPOSE: booleanFromEnv,
  TRUST_PROXY: booleanFromEnv,
});

export type AppEnv = Omit<
  z.infer<typeof envSchema>,
  "COOKIE_SECURE" | "INVITE_TOKEN_EXPOSE" | "TRUST_PROXY" | "DATABASE_SOCKET_DIR"
> & {
  COOKIE_SECURE: boolean;
  INVITE_TOKEN_EXPOSE: boolean;
  TRUST_PROXY: boolean;
  DATABASE_SOCKET_DIR?: string;
};

export function ttlToMs(ttl: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(ttl);
  if (!match) {
    throw new Error(`Invalid TTL: ${ttl}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return amount * multipliers[unit as keyof typeof multipliers];
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const { DATABASE_SOCKET_DIR: socketDir, ...rest } = parsed.data;
  return {
    ...rest,
    ...(socketDir ? { DATABASE_SOCKET_DIR: socketDir } : {}),
    COOKIE_SECURE: parsed.data.COOKIE_SECURE ?? parsed.data.NODE_ENV === "production",
    INVITE_TOKEN_EXPOSE: parsed.data.INVITE_TOKEN_EXPOSE ?? false,
    TRUST_PROXY: parsed.data.TRUST_PROXY ?? parsed.data.NODE_ENV === "production",
  };
}
