import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** The Admin portal (ADR-037): Bizora staff only, never indexed, never framed, talks only to /api/admin. */
const nextConfig: NextConfig = {
  output: process.platform === "win32" ? undefined : "standalone",
  transpilePackages: ["@bizora/ui", "@bizora/contracts"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      { source: "/api/admin/:path*", destination: `${apiOrigin}/api/admin/:path*` },
      { source: "/health", destination: `${apiOrigin}/health` },
    ];
  },
};

export default withNextIntl(nextConfig);
