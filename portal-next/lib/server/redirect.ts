import 'server-only';

import { redirect } from 'next/navigation';

/**
 * Server Component redirect using a relative path so the browser keeps the
 * current hostname and port (e.g. localhost:8080). Absolute redirects built
 * from server headers often drop non-standard ports behind reverse proxies.
 */
export function redirectTo(path: string): never {
  redirect(path.startsWith('/') ? path : `/${path}`);
}
