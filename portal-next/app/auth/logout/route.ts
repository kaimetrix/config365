import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { buildLogoutUrl, derivePublicOrigin } from '@/lib/server/auth';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const session = await getSession();
  session.user  = undefined;
  await session.save();

  const url    = new URL(request.url);
  const origin = derivePublicOrigin(request, url);
  const aadLogoutUrl = (() => {
    try { return buildLogoutUrl(`${origin}/login`); }
    catch { return `${origin}/login`; }
  })();

  return NextResponse.redirect(aadLogoutUrl);
}
