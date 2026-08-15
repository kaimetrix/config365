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

  let authMode = 'oidc';
  let azureConfigured = false;
  try {
    authMode = getSetting('auth_mode') ?? 'oidc';
    azureConfigured = !!getSetting('azure_client_id');
  } catch { /* settings not ready */ }

  // Incomplete setup: only bounce to the wizard when Azure AD is not ready yet.
  // Wizard step 2 signs in via this page (and /login/start) before setup_complete is set.
  // Easy Auth skips /login entirely (/auth/easyauth), which is why Azure App Service worked.
  if (!setupDone && authMode !== 'easyauth' && !azureConfigured) redirect('/setup');

  const session = await getSession();
  if (session.user) redirect(returnTo);

  return (
    <LoginPage
      returnTo={returnTo}
      error={params.error}
      easyAuth={authMode === 'easyauth'}
      azureConfigured={azureConfigured}
    />
  );
}
