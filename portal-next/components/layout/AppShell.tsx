import Sidebar, { type SidebarProps } from './Sidebar';
import GiteaTopBarLink from './GiteaTopBarLink';

interface AppShellProps extends SidebarProps {
  title: string;
  children: React.ReactNode;
  /** If true, page-content fills full remaining viewport height with no scroll */
  fullHeight?: boolean;
  /** Optional right-side content in the top bar */
  topBarRight?: React.ReactNode;
}

export default function AppShell({ title, children, fullHeight, topBarRight, ...sidebarProps }: AppShellProps) {
  const { isAdmin, isMspAdmin } = sidebarProps;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#09090b' }}>
      <Sidebar {...sidebarProps} />

      {/* Main area — pushed right of the fixed sidebar */}
      <div style={{ marginLeft: 220, flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

        {/* Top bar */}
        <div style={{
          height: 52, flexShrink: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '0 24px',
          borderBottom: '1px solid #27272a', background: '#09090b',
          position: 'sticky', top: 0, zIndex: 5,
        }}>
          <span style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#fff' }}>{title}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {topBarRight}
            <GiteaTopBarLink />
            {isAdmin  && <span style={{ fontSize: '0.75rem', color: '#86efac' }}>platform-admin</span>}
            {!isAdmin && isMspAdmin && <span style={{ fontSize: '0.75rem', color: '#93c5fd' }}>msp-admin</span>}
          </div>
        </div>

        {/* Page content */}
        {fullHeight ? (
          <div style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, padding: '16px 24px 0' }}>
            {children}
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 56px' }}>
            {children}
          </div>
        )}

        {/* Sticky mini footer */}
        <style>{`
          .c365-footer-brand { color: #71717a; text-decoration: none; font-weight: 700; letter-spacing: 0.06em; font-size: 0.72rem; }
          .c365-footer-brand:hover { color: #a1a1aa; }
          .c365-footer-credit { color: #52525b; text-decoration: none; }
          .c365-footer-credit:hover { color: #71717a; }
        `}</style>
        <div style={{
          position: 'sticky', bottom: 0, zIndex: 5,
          height: 44, flexShrink: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 2,
          borderTop: '1px solid #27272a', background: '#09090b',
          fontSize: '0.7rem', color: '#52525b',
          letterSpacing: '0.01em', lineHeight: 1.4,
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <a href="https://config365.io" target="_blank" rel="noopener noreferrer" className="c365-footer-brand">
              CONFIG365
            </a>
            <span style={{ color: '#3f3f46' }}>·</span>
            <a href="https://service365.io" target="_blank" rel="noopener noreferrer" className="c365-footer-brand">
              SERVICE365
            </a>
          </span>
          <span>
            Projects by&nbsp;
            <a href="https://potsolutions.net" target="_blank" rel="noopener noreferrer" className="c365-footer-credit">
              PotSolutions
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
