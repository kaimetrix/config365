import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Standalone output bundles only the files needed to run the server.
  // The Docker image copies .next/standalone/ as the self-contained app.
  output: 'standalone',

  // Native/large Node.js modules that cannot be bundled by Next.js
  serverExternalPackages: ['better-sqlite3', 'mssql', 'tedious'],

  // Disable the default origin check — portal uses Azure AD session auth which
  // is a stronger CSRF guard. Without this, Docker deployments fail when the
  // server binds to 0.0.0.0 but browsers connect via a different hostname.
  // Note: Next.js handles CSRF differently from Astro; this mirrors the same
  // config365 portal security posture.

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
