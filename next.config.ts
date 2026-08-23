import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // jsdom is a server-only dependency (DOMPurify backend for the
  // sanitize.server.ts chokepoint). Bundling it for the client fails
  // (it requires Node's `fs`), so keep it as a server external.
  serverExternalPackages: ["jsdom"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
