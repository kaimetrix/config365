'use client';

export default function GiteaTopBarLink() {
  // Gitea is served by Caddy at /gitea/ on the same origin as the portal
  const href =
    typeof window !== 'undefined'
      ? `${window.location.origin}/gitea/`
      : '/gitea/';

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open Gitea"
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        color: '#71717a', textDecoration: 'none',
        fontSize: '0.75rem', fontWeight: 500,
        padding: '4px 8px', borderRadius: 5,
        border: '1px solid #27272a',
        transition: 'color 0.15s, border-color 0.15s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLAnchorElement).style.color = '#e4e4e7';
        (e.currentTarget as HTMLAnchorElement).style.borderColor = '#52525b';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLAnchorElement).style.color = '#71717a';
        (e.currentTarget as HTMLAnchorElement).style.borderColor = '#27272a';
      }}
    >
      {/* Gitea logomark */}
      <svg width="13" height="13" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
        <path d="M16 0C7.163 0 0 7.163 0 16c0 8.836 7.163 16 16 16s16-7.164 16-16C32 7.163 24.837 0 16 0zm7.71 19.612c-.34 1.28-1.458 2.17-2.78 2.17H11.07c-1.322 0-2.44-.89-2.78-2.17L6.77 12.39a.772.772 0 0 1 .748-.97h16.964a.772.772 0 0 1 .748.97l-1.52 7.222zM20.308 9.23H11.69a1.538 1.538 0 1 1 0-3.077h8.618a1.538 1.538 0 1 1 0 3.077z"/>
      </svg>
      Gitea
    </a>
  );
}
