/**
 * Next.js Edge middleware — auth gate only (no DB access).
 *
 * Checks the iron-session cookie to verify the user is authenticated.
 * DB-dependent checks (setup_complete, MSP resolution, bootstrap) are handled
 * in the root layout (Node.js Server Component).
 */

import { getIronSession } from 'iron-session';
import { NextResponse, type NextRequest } from 'next/server';
import type { SessionData } from '@/lib/server/session';
import { absoluteUrl } from '@/lib/public-origin';

const PUBLIC_PATHS = [
  '/login',
  '/login/start',
  '/auth/callback',
  '/auth/easyauth',
  '/auth/logout',
  '/setup',
  '/api/setup',
  '/api/health',
  // token-api → portal tenant lookup (auth via Bearer SESSION_SECRET on the route)
  '/api/internal',
  '/reset',
  '/api/reset',
  '/favicon.svg',
  '/favicon.ico',
  '/robots.txt',
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function getSessionOptions() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return {
    cookieName: 'c365_session',
    password: secret,
    ttl: 60 * 60 * 8,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.SECURE_COOKIES === 'true',
      sameSite: 'lax' as const,
      path: '/',
    },
  };
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow public routes
  if (isPublicPath(pathname)) return NextResponse.next();

  // Static assets from Next.js internals
  if (pathname.startsWith('/_next/') || pathname.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  const sessionOpts = getSessionOptions();

  // If SESSION_SECRET is not configured, only allow /setup
  if (!sessionOpts) {
    if (pathname !== '/setup') {
      return NextResponse.redirect(absoluteUrl('/setup', request.headers, request.nextUrl));
    }
    return NextResponse.next();
  }

  // Decrypt and check the session cookie
  let user: SessionData['user'] | undefined;
  try {
    // iron-session v8 + Next.js 15: request.cookies is narrower than the expected type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await getIronSession<SessionData>(request.cookies as any, sessionOpts);
    user = session.user;
  } catch {
    // Cookie is present but corrupted/expired — treat as unauthenticated
    user = undefined;
  }

  if (!user) {
    // API routes get 401, HTML routes get redirect
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
    }
    const returnPath = pathname + request.nextUrl.search;
    const loginUrl = absoluteUrl('/login', request.headers, request.nextUrl);
    loginUrl.searchParams.set('returnTo', returnPath);
    return NextResponse.redirect(loginUrl);
  }

  // Pass user info to Server Components via headers
  const response = NextResponse.next();
  response.headers.set('x-user-id', user.userId);
  response.headers.set('x-user-email', user.email);
  response.headers.set('x-user-roles', JSON.stringify(user.roles));
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico / favicon.svg
     */
    '/((?!_next/static|_next/image|favicon).*)',
  ],
};
