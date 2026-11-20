import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Standalone tracing uses symlinks; Windows without Developer Mode cannot create them.
  // Linux CI and Cloud Run images still emit the standalone output.
  output: process.platform === "win32" ? undefined : "standalone",
  transpilePackages: ["@bizora/ui", "@bizora/contracts"],
  experimental: {
    // Import only the components and contracts a page uses, not whole packages (Spec §8 JavaScript budget).
    optimizePackageImports: ["@bizora/ui", "@bizora/contracts", "@bizora/money"],
  },
  // Basic protection on every page (review, 19 Nov): no framing by other sites, no type guessing, HTTPS only, and
  // camera and microphone for this site alone (photo and voice capture).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      // Offline voice files (ADR-040) have their version in the path, so a browser may keep them for good.
      {
        source: "/voice/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
  // The speech library has Node-only parts that the browser never loads.
  webpack(config, { isServer }) {
    if (!isServer) {
      config.resolve.alias = { ...config.resolve.alias, sharp$: false, "onnxruntime-node$": false };
    }
    return config;
  },
  async rewrites() {
    return [
      // The Admin portal's API is reached only from the portal's own address (ADR-037).
      { source: "/api/:path((?!admin/).*)", destination: `${apiOrigin}/api/:path` },
      { source: "/health", destination: `${apiOrigin}/health` },
      { source: "/ready", destination: `${apiOrigin}/ready` },
    ];
  },
};

export default withNextIntl(nextConfig);
