import { NextResponse } from 'next/server';

/**
 * GET /api/health
 *
 * Lightweight liveness probe — returns 200 as soon as the Node.js process is
 * accepting connections. No DB access, no bootstrap calls.
 * Used by portal-warmup.sh to detect when Next.js is ready, and can be set
 * as the Azure App Service health check path.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ ok: true });
}
