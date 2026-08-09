'use client';

interface LoginPageProps {
  returnTo: string;
  error?: string;
  easyAuth: boolean;
  azureConfigured: boolean;
}

export function LoginPage({ returnTo, error, easyAuth, azureConfigured }: LoginPageProps) {
  const safeReturn = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
  const startHref = `/login/start?returnTo=${encodeURIComponent(safeReturn)}`;
  const easyAuthHref = `/auth/easyauth?returnTo=${encodeURIComponent(safeReturn)}`;

  return (
    <div style={{
      margin: 0, background: '#09090b', color: '#e4e4e7', fontFamily: 'system-ui,sans-serif',
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        background: '#18181b', border: '1px solid #27272a', borderRadius: 12,
        padding: 40, maxWidth: 420, width: '100%', textAlign: 'center',
      }}>
        <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 6 }}>Config365</h1>
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginBottom: 28 }}>
          Sign in to manage Microsoft 365 configurations.
        </p>

        {error && (
          <div style={{
            background: '#450a0a', color: '#fca5a5', border: '1px solid #7f1d1d',
            borderRadius: 6, padding: '10px 14px', fontSize: '0.85rem', marginBottom: 20, textAlign: 'left',
          }}>
            {error}
          </div>
        )}

        {easyAuth ? (
          <a
            href={easyAuthHref}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              width: '100%', padding: '12px 20px', borderRadius: 8, border: 'none',
              background: '#3b82f6', color: '#fff', fontSize: '0.95rem', fontWeight: 600,
              textDecoration: 'none', cursor: 'pointer', boxSizing: 'border-box',
            }}
          >
            Continue with Microsoft
          </a>
        ) : azureConfigured ? (
          <a
            href={startHref}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              width: '100%', padding: '12px 20px', borderRadius: 8, border: 'none',
              background: '#3b82f6', color: '#fff', fontSize: '0.95rem', fontWeight: 600,
              textDecoration: 'none', cursor: 'pointer', boxSizing: 'border-box',
            }}
          >
            <MicrosoftIcon />
            Sign in with Microsoft
          </a>
        ) : (
          <p style={{ color: '#71717a', fontSize: '0.85rem' }}>
            Azure AD is not configured.{' '}
            <a href="/setup" style={{ color: '#3b82f6' }}>Complete setup</a>
          </p>
        )}
      </div>
    </div>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
