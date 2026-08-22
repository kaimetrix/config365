'use client';
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

export interface SidebarProps {
  msps: Array<{ slug: string; displayName: string }>;
  currentMspSlug?: string;
  isAdmin: boolean;
  isMspAdmin: boolean;
  userMspSlug: string | null;
  userDisplayName: string;
  userEmail: string;
}

/* ── SVG icons (inline) ────────────────────────────────── */
const Icon = {
  dashboard: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/>
      <rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/>
    </svg>
  ),
  viewer: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 3h12M2 3v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V3M5 3V1h6v2"/>
      <line x1="5" y1="7" x2="11" y2="7"/><line x1="5" y1="10" x2="9" y2="10"/>
    </svg>
  ),
  baseline: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <ellipse cx="8" cy="4" rx="6" ry="2"/>
      <path d="M2 4v4c0 1.1 2.7 2 6 2s6-.9 6-2V4"/><path d="M2 8v4c0 1.1 2.7 2 6 2s6-.9 6-2V8"/>
    </svg>
  ),
  timeline: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6"/><polyline points="8 4 8 8 11 10"/>
    </svg>
  ),
  intune: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="3" width="14" height="10" rx="1.5"/>
      <path d="M5 3V2M11 3V2"/><path d="M1 7h14"/>
    </svg>
  ),
  apps: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/>
      <rect x="2" y="9" width="5" height="5" rx="1"/><path d="M9 11.5h5M11.5 9v5"/>
    </svg>
  ),
  printers: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="5" width="10" height="7" rx="1"/>
      <path d="M5 5V3h6v2"/><path d="M5 9h6"/><path d="M5 11h4"/>
    </svg>
  ),
  admx: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>
      <path d="M10 2v3h3"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="11" x2="9" y2="11"/>
    </svg>
  ),
  osversion: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="3" width="14" height="10" rx="1.5"/>
      <path d="M4 8h8M4 11h5"/><circle cx="12" cy="6" r="1.5"/>
    </svg>
  ),
  applocker: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="7" width="10" height="7" rx="1"/>
      <path d="M5 7V5a3 3 0 0 1 6 0v2"/>
    </svg>
  ),
  deviceCompliance: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="1.5"/>
      <path d="M5 8l2 2 4-4"/>
    </svg>
  ),
  groups: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6" cy="5" r="2.5"/><path d="M1 13c0-2.2 2-4 5-4s5 1.8 5 4"/>
      <circle cx="12" cy="5" r="2"/><path d="M12 9c1.5 0 3 .9 3 2.5"/>
    </svg>
  ),
  ca: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 1.5 L14 4 L14 8 C14 11.5 11 13.8 8 14.5 C5 13.8 2 11.5 2 8 L2 4 Z"/>
      <polyline points="5.5 8 7.5 10 11 6"/>
    </svg>
  ),
  maintenance: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M13.5 2.5 L11 5 L9.5 6.5 M13.5 2.5 C13.5 2.5 14 3.5 13.5 4.5 L11 5 M9.5 6.5 L3 13 Q2 14 1 13 Q0 12 1 11 L7.5 4.5"/>
    </svg>
  ),
  variables: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4h10M3 8h7M3 12h10"/>
      <circle cx="12.5" cy="8" r="1.5"/>
    </svg>
  ),
  secureScore: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 1.5 L14 4 L14 8 C14 11.5 11 13.8 8 14.5 C5 13.8 2 11.5 2 8 L2 4 Z"/>
      <polyline points="5 8.5 7 10.5 11 6.5"/>
    </svg>
  ),
  compliance: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="5" r="2.5"/>
      <path d="M1.5 13.5c0-2.5 2.5-4 5.5-4"/>
      <polyline points="9.5 11 11 12.5 14.5 9"/>
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="2.5"/>
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4"/>
    </svg>
  ),
  iam: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="6" r="3"/><path d="M2 14c0-3 2.7-5 6-5s6 2 6 5"/>
    </svg>
  ),
  platform: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="2" width="14" height="10" rx="1.5"/>
      <path d="M5 15h6M8 12v3"/>
    </svg>
  ),
  gitea: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5" cy="4" r="2"/><circle cx="11" cy="4" r="2"/><circle cx="8" cy="12" r="2"/>
      <line x1="5" y1="6" x2="8" y2="10"/><line x1="11" y1="6" x2="8" y2="10"/>
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="4 2 8 6 4 10"/>
    </svg>
  ),
};

export default function Sidebar({
  msps,
  currentMspSlug,
  isAdmin,
  isMspAdmin,
  userMspSlug,
  userDisplayName,
  userEmail,
}: SidebarProps) {
  const pathname = usePathname();
  const router   = useRouter();
  const [intuneOpen, setIntuneOpen] = useState(() => {
    return pathname.includes('/apps') || pathname.includes('/printers') || pathname.includes('/admx') || pathname.includes('/os-versions') || pathname.includes('/applocker');
  });

  const mspBase    = currentMspSlug ? `/msps/${currentMspSlug}` : '';
  const currentMsp = msps.find(m => m.slug === currentMspSlug);
  function active(href: string) {
    if (href === `${mspBase}` || href === `${mspBase}/`) {
      return pathname === href || pathname === `${mspBase}/`;
    }
    return pathname.startsWith(href);
  }

  const isIntuneGroup = active(`${mspBase}/apps`) || active(`${mspBase}/printers`) || active(`${mspBase}/admx`) || active(`${mspBase}/os-versions`) || active(`${mspBase}/applocker`);

  return (
    <aside style={{
      width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column',
      background: '#111113', borderRight: '1px solid #27272a',
      position: 'fixed', top: 0, left: 0, height: '100vh', overflowY: 'auto', zIndex: 10,
    }}>
      {/* Logo */}
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid #27272a' }}>
        <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: '#fff', letterSpacing: '-0.01em', lineHeight: 1.2 }}>
          CONFIG365
        </div>
        <div style={{ fontSize: '0.6875rem', color: '#52525b', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Tenant Management
        </div>
        {currentMsp && (
          <div style={{
            display: 'inline-block', marginTop: 8, fontSize: '0.6875rem',
            color: '#a1a1aa', background: '#27272a', padding: '2px 8px', borderRadius: 4,
          }}>
            {currentMsp.displayName}
          </div>
        )}
      </div>

      {/* MSP switcher */}
      {msps.length > 1 && isAdmin && (
        <div style={{ padding: '10px 10px 4px' }}>
          <select
            value={currentMspSlug ?? ''}
            onChange={e => { if (e.target.value) router.push(`/msps/${e.target.value}`); }}
            style={{
              background: '#09090b', border: '1px solid #27272a', color: '#e4e4e7',
              borderRadius: 6, padding: '6px 10px', fontSize: '0.8125rem', width: '100%',
              cursor: 'pointer', fontFamily: 'inherit', outline: 'none',
            }}
          >
            <option value="" disabled>Switch MSP…</option>
            {msps.map(m => (
              <option key={m.slug} value={m.slug}>{m.displayName}</option>
            ))}
          </select>
        </div>
      )}

      {/* Main nav */}
      {currentMspSlug && (
        <nav style={{ flex: 1, padding: '12px 10px', overflowY: 'auto' }}>
          {/* Management section */}
          <SectionLabel>Management</SectionLabel>

          <NavItem href={`${mspBase}`} active={active(`${mspBase}`)} icon={Icon.dashboard}>Dashboard</NavItem>
          <NavItem href={`${mspBase}/user-compliance`} active={active(`${mspBase}/user-compliance`)} icon={Icon.compliance}>User Compliance</NavItem>
          <NavItem href={`${mspBase}/device-compliance`} active={active(`${mspBase}/device-compliance`)} icon={Icon.deviceCompliance}>Device Compliance</NavItem>
          <NavItem href={`${mspBase}/secure-score`} active={active(`${mspBase}/secure-score`)} icon={Icon.secureScore}>Secure Score</NavItem>
          <NavItem href={`${mspBase}/viewer`} active={active(`${mspBase}/viewer`)} icon={Icon.viewer}>Policy Viewer</NavItem>
          <NavItem href={`${mspBase}/baseline`} active={active(`${mspBase}/baseline`)} icon={Icon.baseline}>Baseline</NavItem>
          <NavItem href={`${mspBase}/timeline`} active={active(`${mspBase}/timeline`)} icon={Icon.timeline}>Timeline</NavItem>

          {/* Intune collapsible group */}
          <div style={{ marginBottom: 1 }}>
            <button
              onClick={() => setIntuneOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px',
                borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500,
                color: isIntuneGroup ? '#22c55e' : '#a1a1aa',
                cursor: 'pointer', background: 'transparent', border: 'none',
                width: '100%', textAlign: 'left', fontFamily: 'inherit',
                transition: 'background 0.12s, color 0.12s',
              }}
              onMouseEnter={e => { if (!isIntuneGroup) (e.currentTarget as HTMLElement).style.background = '#18181b'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ width: 16, height: 16, opacity: 0.8, flexShrink: 0, display: 'flex' }}>{Icon.intune}</span>
              <span>Intune</span>
              <span style={{
                marginLeft: 'auto', width: 12, height: 12, flexShrink: 0, opacity: 0.5,
                display: 'flex', transition: 'transform 0.18s',
                transform: (intuneOpen || isIntuneGroup) ? 'rotate(90deg)' : 'none',
              }}>{Icon.chevron}</span>
            </button>
            <div style={{
              overflow: 'hidden', maxHeight: (intuneOpen || isIntuneGroup) ? 360 : 0,
              transition: 'max-height 0.2s ease',
            }}>
              <NavSubItem href={`${mspBase}/apps`} active={active(`${mspBase}/apps`)} icon={Icon.apps}>Apps</NavSubItem>
              <NavSubItem href={`${mspBase}/printers`} active={active(`${mspBase}/printers`)} icon={Icon.printers}>Printers</NavSubItem>
              <NavSubItem href={`${mspBase}/admx`} active={active(`${mspBase}/admx`)} icon={Icon.admx}>ADMX Files</NavSubItem>
              <NavSubItem href={`${mspBase}/os-versions`} active={active(`${mspBase}/os-versions`)} icon={Icon.osversion}>OS Version Control</NavSubItem>
              <NavSubItem href={`${mspBase}/applocker`} active={active(`${mspBase}/applocker`)} icon={Icon.applocker}>AppLocker</NavSubItem>
            </div>
          </div>

          <NavItem href={`${mspBase}/groups`} active={active(`${mspBase}/groups`)} icon={Icon.groups}>Groups</NavItem>
          <NavItem href={`${mspBase}/variables`} active={active(`${mspBase}/variables`)} icon={Icon.variables}>Variables</NavItem>
          <NavItem href={`${mspBase}/ca`} active={active(`${mspBase}/ca`)} icon={Icon.ca}>CA Options</NavItem>
          <NavItem href={`${mspBase}/maintenance`} active={active(`${mspBase}/maintenance`)} icon={Icon.maintenance}>Maintenance</NavItem>
        </nav>
      )}

      {/* No MSP selected — list MSPs */}
      {!currentMspSlug && msps.length > 0 && (
        <nav style={{ flex: 1, padding: '12px 10px' }}>
          <SectionLabel>Select MSP</SectionLabel>
          {msps.map(m => (
            <NavItem key={m.slug} href={`/msps/${m.slug}`} active={false} icon={Icon.settings}>
              {m.displayName}
            </NavItem>
          ))}
        </nav>
      )}

      {/* Platform admin links */}
      {isAdmin && (
        <nav style={{ padding: '4px 10px' }}>
          <div style={{ height: 1, background: '#27272a', margin: '4px 0 8px' }} />
          <SectionLabel>Platform</SectionLabel>
          <NavItem href="/admin"          active={pathname === '/admin'} icon={Icon.platform}>MSPs &amp; Tenants</NavItem>
          <NavItem href="/admin/iam"      active={pathname.startsWith('/admin/iam')} icon={Icon.iam}>IAM</NavItem>
          <NavItem href="/admin/platform" active={pathname.startsWith('/admin/platform') || pathname.startsWith('/admin/gitea')} icon={Icon.platform}>Platform</NavItem>
        </nav>
      )}

      {/* Footer */}
      <div style={{ padding: '12px 14px', borderTop: '1px solid #27272a' }}>
        <div style={{ fontSize: '0.78rem', color: '#52525b', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {userDisplayName || userEmail}
        </div>
        <a href="/auth/logout" style={{
          fontSize: '0.75rem', color: '#52525b', textDecoration: 'none',
          padding: '5px 10px', border: '1px solid #27272a', borderRadius: 5, display: 'inline-block',
        }}>
          Sign out
        </a>
      </div>
    </aside>
  );
}

/* ── Sub-components ──────────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '0.6875rem', fontWeight: 600, color: '#52525b',
      textTransform: 'uppercase', letterSpacing: '0.08em',
      padding: '8px 10px 4px', marginTop: 4,
    }}>{children}</div>
  );
}

function NavItem({ href, active, icon, children }: {
  href: string; active: boolean; icon: React.ReactNode; children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={href}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px',
        borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, textDecoration: 'none',
        color: active ? '#22c55e' : hover ? '#fff' : '#a1a1aa',
        background: active ? 'rgba(34,197,94,0.12)' : hover ? '#18181b' : 'transparent',
        cursor: 'pointer', marginBottom: 1, transition: 'background 0.12s, color 0.12s',
      }}
    >
      <span style={{ width: 16, height: 16, opacity: active ? 1 : 0.8, flexShrink: 0, display: 'flex' }}>{icon}</span>
      {children}
    </a>
  );
}

function NavSubItem({ href, active, icon, children }: {
  href: string; active: boolean; icon: React.ReactNode; children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={href}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '6px 10px 6px 32px',
        borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, textDecoration: 'none',
        color: active ? '#22c55e' : hover ? '#e4e4e7' : '#71717a',
        background: active ? 'rgba(34,197,94,0.08)' : hover ? '#18181b' : 'transparent',
        cursor: 'pointer', marginBottom: 1, transition: 'background 0.12s, color 0.12s',
      }}
    >
      <span style={{ width: 14, height: 14, opacity: 0.7, flexShrink: 0, display: 'flex' }}>{icon}</span>
      {children}
    </a>
  );
}
