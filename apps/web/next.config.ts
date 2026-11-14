import type { NextConfig } from "next";

const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  // Standalone tracing uses symlinks; Windows without Developer Mode cannot create them.
  // Linux CI and Cloud Run images still emit the standalone output.
  output: process.platform === "win32" ? undefined : "standalone",
  transpilePackages: ["@bizora/ui", "@bizora/contracts"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
      { source: "/health", destination: `${apiOrigin}/health` },
      { source: "/ready", destination: `${apiOrigin}/ready` },
    ];
  },
};

export default nextConfig;
