import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { listIamAssignments, upsertIamAssignment, deleteIamAssignment, type IamRole } from '@/lib/server/tenant-store';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);
  return json(await listIamAssignments());
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  let body: { userId: string; email: string; displayName?: string; role: IamRole; mspSlug?: string | null };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.userId || !body.email || !body.role) return json({ error: 'userId, email, and role are required' }, 400);

  try {
    const assignment = await upsertIamAssignment({ userId: body.userId, email: body.email, displayName: body.displayName ?? '', role: body.role, mspSlug: body.mspSlug });
    return json(assignment, 201);
  } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const id = request.nextUrl.searchParams.get('id');
  if (!id) return json({ error: 'id is required' }, 400);

  const deleted = await deleteIamAssignment(id);
  if (!deleted) return json({ error: 'Assignment not found' }, 404);
  return json({ ok: true });
}
