/**
 * Setup page — Server Component wrapper.
 *
 * Runs on the server so we can check isSetupComplete() synchronously and
 * issue a hard server-side redirect before any HTML is sent to the browser.
 * This prevents the client-side "Loading → redirect" flash that caused the
 * perceived "looping setup" experience.
 */
import { headers } from 'next/headers';
import { isSetupComplete, getSetting } from '@/lib/server/tenant-store';
import { getSession } from '@/lib/server/session';
import { derivePublicOriginFromHeaders } from '@/lib/public-origin';
import { redirectTo } from '@/lib/server/redirect';
import { SetupWizard } from './SetupWizard';

// Always render at request time — setup state changes after the wizard completes
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  // Redirect immediately on the server — no client-side flash
  let setupDone = false;
  try { setupDone = isSetupComplete(); } catch { /* DB not yet accessible */ }
  if (setupDone) redirectTo('/');

  const reqHeaders = await headers();
  const derivedRedirectUri = `${derivePublicOriginFromHeaders(reqHeaders)}/auth/callback`;

  // Check whether the user already has an active session.
  // Used to decide whether to land on the "Sign in" gate or jump straight to
  // the database step when resuming a partially-completed setup.
  let hasSession = false;
  try {
    const session = await getSession();
    hasSession = !!session.user;
  } catch { /* session not yet configured — treat as unauthenticated */ }

  // Resume at the correct step if the user has already partially completed setup.
  // All getSetting calls are try/caught — SQLite may be unavailable on first boot.
  const isEasyAuth = (() => { try { return getSetting('auth_mode') === 'easyauth'; } catch { return false; } })();
  const defaults = {
    azureStep: (() => {
      try {
        // Easy Auth mode: no azure_client_id is saved, so check auth_mode instead
        if (isEasyAuth) return 'database';
        if (!getSetting('azure_client_id')) return 'azure';
        return hasSession ? 'database' : 'authenticate';
      } catch { return 'azure'; }
    })() as 'azure' | 'authenticate' | 'database',
    defaultRedirectUri: (() => {
      try { return getSetting('azure_redirect_uri') ?? derivedRedirectUri; }
      catch { return derivedRedirectUri; }
    })(),
    isEasyAuth,
  };

  return <SetupWizard defaults={defaults} />;
}
