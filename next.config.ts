import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Opus encoder is a large generated JavaScript file; load it as-is rather than bundling it.
  serverExternalPackages: ["opusscript"],
};

export default nextConfig;
