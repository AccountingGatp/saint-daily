import type { NextConfig } from "next";

const apiOrigin =
"https://saint-daily-gatp-api.vercel.app"
  // process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
  // "http://localhost:4000";

const nextConfig: NextConfig = {
  async rewrites() {
    // Local only: proxy /api → Express. In production the browser calls
    // NEXT_PUBLIC_API_URL directly (see page.tsx).
    if (process.env.NODE_ENV === "development") {
      return [
        {
          source: "/api/:path*",
          destination: `${apiOrigin}/api/:path*`,
        },
      ];
    }
    return [];
  },
};

export default nextConfig;
