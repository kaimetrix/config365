import { redirect } from 'next/navigation';
import { getSession } from '@/lib/server/session';
import { getSetting, isSetupComplete } from '@/lib/server/tenant-store';
import { sanitizeReturnTo } from '@/lib/server/auth';
import { LoginPage } from './LoginPage';

export const dynamic = 'force-dynamic';

export default async function LoginScreen({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}) {
  const params = await searchParams;
  const returnTo = sanitizeReturnTo(params.returnTo);

  let setupDone = false;
  try { setupDone = isSetupComplete(); } catch { /* DB not ready */ }
  if (!setupDone) redirect('/setup');

  const session = await getSession();
  if (session.user) redirect(returnTo);

  let authMode = 'oidc';
  let azureConfigured = false;
  try {
    authMode = getSetting('auth_mode') ?? 'oidc';
    azureConfigured = !!getSetting('azure_client_id');
  } catch { /* settings not ready */ }

  return (
    <LoginPage
      returnTo={returnTo}
      error={params.error}
      easyAuth={authMode === 'easyauth'}
      azureConfigured={azureConfigured}
    />
  );
}
