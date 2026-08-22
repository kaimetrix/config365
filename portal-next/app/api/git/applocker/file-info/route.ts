/**
 * POST /api/git/applocker/file-info
 * Parse an uploaded binary in memory and return AppLocker publisher / hash info.
 * Never writes to Gitea.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { requireMspAccess } from '@/lib/server/authz';
import { parseAppLockerFileInfo, maxAppLockerUploadBytes } from '@/lib/applocker-fileinfo';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  let body: { mspSlug?: string; fileName?: string; contentBase64?: string };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.mspSlug) return json({ error: 'mspSlug required' }, 400);
  const guard = await requireMspAccess(session.user, body.mspSlug);
  if (guard instanceof NextResponse) return guard;

  if (!body.fileName || !body.contentBase64) {
    return json({ error: 'fileName and contentBase64 are required' }, 400);
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(body.contentBase64, 'base64');
  } catch {
    return json({ error: 'Invalid base64' }, 400);
  }

  if (buf.length === 0) return json({ error: 'File is empty' }, 400);
  if (buf.length > maxAppLockerUploadBytes()) {
    return json({ error: `File exceeds ${maxAppLockerUploadBytes() / (1024 * 1024)} MB limit` }, 400);
  }

  try {
    return json(parseAppLockerFileInfo(body.fileName, buf));
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 400);
  }
}
