import 'server-only';
import { getIronSession, type IronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import { getSetting, getIamAssignmentForUser } from './tenant-store';

export interface SessionUser {
  userId: string;
  displayName: string;
  email: string;
  roles: string[];
  tenantSlug: string | null;
}

export interface SessionData {
  user?: SessionUser;
}

export function getSessionOptions(): SessionOptions {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters long.');
  }
  return {
    cookieName: 'c365_session',
    password: secret,
    ttl: 60 * 60 * 8,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.SECURE_COOKIES === 'true',
      sameSite: 'lax',
      path: '/',
    },
  };
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, getSessionOptions());
}

export interface MspAdminInfo {
  isMspAdmin: boolean;
  userMspSlug: string | null;
}

export async function getMspAdminInfo(user: SessionUser | undefined): Promise<MspAdminInfo> {
  if (!user) return { isMspAdmin: false, userMspSlug: null };
  try {
    const assignment = await getIamAssignmentForUser(user.userId);
    if (assignment?.role === 'msp-admin' && assignment.mspSlug) {
      return { isMspAdmin: true, userMspSlug: assignment.mspSlug };
    }
  } catch { /* DB not ready */ }
  return { isMspAdmin: false, userMspSlug: null };
}

export function isPlatformAdmin(user: SessionUser | undefined): boolean {
  if (!user) return false;
  if (user.roles.includes('platform-admin')) return true;
  try {
    if (getSetting('first_admin_oid') === user.userId) return true;
  } catch { /* DB not ready */ }
  const adminOids = (process.env.PLATFORM_ADMIN_OIDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return adminOids.includes(user.userId);
}
