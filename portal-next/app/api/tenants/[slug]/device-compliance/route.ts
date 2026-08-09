/**
 * GET /api/tenants/[slug]/device-compliance
 *
 * Reads Intune managed devices, MAM registrations, and MDE inventory from
 * tenant backup files and returns a merged device compliance view.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getFile } from '@/lib/server/gitea';
import { requireTenantAccess } from '@/lib/server/authz';
import {
  mergeDeviceComplianceData,
  summarizeDevices,
  type MamRegistrationRecord,
  type ManagedDeviceRecord,
  type MdeDeviceRecord,
} from '@/lib/device-compliance-merge';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

async function loadJsonArray<T>(org: string, repo: string, path: string): Promise<{ data: T[]; exists: boolean }> {
  const result = await getFile(org, repo, path).catch(() => ({ exists: false, content: '' }));
  if (!result.exists) return { data: [], exists: false };
  try {
    const parsed = JSON.parse(result.content);
    return { data: Array.isArray(parsed) ? parsed : [], exists: true };
  } catch {
    return { data: [], exists: true };
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const org = tenant.giteaOrg;
  const repo = `tenant-${tenant.slug}`;

  const [managedResult, mamResult, mdeResult] = await Promise.all([
    loadJsonArray<ManagedDeviceRecord>(org, repo, 'backups/intune/managed-devices.json'),
    loadJsonArray<MamRegistrationRecord>(org, repo, 'backups/intune/mam-registrations.json'),
    loadJsonArray<MdeDeviceRecord>(org, repo, 'backups/defender-devices/all-devices.json'),
  ]);

  const hasAnyData = managedResult.exists || mamResult.exists || mdeResult.exists;
  const hasDeviceData = managedResult.data.length > 0 || mamResult.data.length > 0 || mdeResult.data.length > 0;

  if (!hasAnyData) {
    return json({
      slug,
      hasBackup: false,
      devices: [],
      summary: summarizeDevices([]),
    });
  }

  const merged = mergeDeviceComplianceData(managedResult.data, mamResult.data, mdeResult.data);
  const summary = summarizeDevices(merged);

  return json({
    slug,
    hasBackup: hasDeviceData,
    managedDevicesAvailable: managedResult.exists,
    managedDeviceCount: managedResult.data.length,
    mamRegistrationsAvailable: mamResult.exists,
    mdeDevicesAvailable: mdeResult.exists,
    mdeDeviceCount: mdeResult.data.length,
    intuneInventoryMissing: !managedResult.exists || managedResult.data.length === 0,
    summary,
    deviceCount: merged.length,
    devices: merged,
  });
}
