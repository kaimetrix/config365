import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function reltime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Converts a Gitea-internal html_url to the portal-relative /gitea/... path.
 *
 * In production (AIO mode), Gitea is served under /gitea/ via Caddy, so all
 * links must use that path prefix instead of pointing to port 3000 directly.
 * In development the Docker compose hostname replacement is used as fallback.
 */
export function toGiteaWebUrl(htmlUrl: string): string {
  try {
    const url = new URL(htmlUrl);
    if (process.env.NODE_ENV === 'production') {
      // Gitea ROOT_URL may already include /gitea/ in the path — don't double it.
      const prefix = url.pathname.startsWith('/gitea') ? '' : '/gitea';
      return prefix + url.pathname + url.search + url.hash;
    }
    // Dev: replace the Docker internal hostname with localhost
    return htmlUrl.replace('http://gitea:3000', 'http://localhost:3000');
  } catch {
    return htmlUrl;
  }
}

export function runStatusInfo(status: string | null | undefined): { cls: string; label: string; pulse: boolean } {
  switch (status) {
    case 'success':   return { cls: 'badge-success', label: 'Succeeded', pulse: false };
    case 'failure':   return { cls: 'badge-failure', label: 'Failed',    pulse: false };
    case 'running':   return { cls: 'badge-running', label: 'Running',   pulse: true  };
    case 'waiting':   return { cls: 'badge-warning', label: 'Waiting',   pulse: true  };
    case 'cancelled': return { cls: 'badge-neutral', label: 'Cancelled', pulse: false };
    case 'skipped':   return { cls: 'badge-neutral', label: 'Skipped',   pulse: false };
    default:          return { cls: 'badge-neutral', label: status ?? 'Idle', pulse: false };
  }
}
