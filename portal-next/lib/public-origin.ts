/**
 * Public origin derivation — safe for Edge middleware and Node route handlers.
 *
 * When PUBLIC_URL is set (e.g. Azure App Service HTTPS URL), it overrides all
 * proxy-header detection. Otherwise derives from proxy headers; preserves
 * non-default ports (e.g. localhost:8080).
 */

/** PUBLIC_URL env override — full origin, e.g. https://app.azurewebsites.net */
function configuredPublicOrigin(): string | null {
  const raw = process.env.PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function isDefaultPort(proto: string, port: string): boolean {
  return (proto === 'http' && port === '80') || (proto === 'https' && port === '443');
}

/** Parse host= from RFC 7239 Forwarded header (first hop). */
function hostFromForwarded(forwarded: string): string | null {
  const match = forwarded.match(/(?:^|,|\s)host="?([^";,\s]+)"?/i);
  return match?.[1]?.trim() ?? null;
}

function isInternalHost(host: string): boolean {
  const hostname = host.split(':')[0].toLowerCase();
  return hostname === '0.0.0.0';
}

function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.split(',')[0].trim().replace(/\/$/, '');
  if (isInternalHost(host)) return null;
  if (host.endsWith(':4321')) {
    host = host.slice(0, -':4321'.length);
  }
  return host || null;
}

export function derivePublicOriginFromHeaders(headers: Headers, fallbackUrl?: URL): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;

  const forwarded = headers.get('forwarded');

  const proto =
    headers.get('x-forwarded-proto')?.split(',')[0].trim() ||
    (headers.get('x-arr-ssl') !== null ? 'https' : null) ||
    fallbackUrl?.protocol.replace(/:$/, '') ||
    'http';

  let host =
    normalizeHost(headers.get('x-forwarded-host')) ??
    normalizeHost(forwarded ? hostFromForwarded(forwarded) : null) ??
    normalizeHost(headers.get('host')) ??
    normalizeHost(fallbackUrl?.host) ??
    'localhost';

  // Reverse proxies often strip the port from X-Forwarded-Host / Host.
  if (!host.includes(':')) {
    const forwardedPort = headers.get('x-forwarded-port')?.split(',')[0].trim();
    if (forwardedPort && !isDefaultPort(proto, forwardedPort)) {
      host = `${host}:${forwardedPort}`;
    }
  }

  return `${proto}://${host}`;
}

/** Build an absolute URL for a path using the request's public origin. */
export function absoluteUrl(path: string, headers: Headers, fallbackUrl?: URL): URL {
  const origin = derivePublicOriginFromHeaders(headers, fallbackUrl);
  return new URL(path.startsWith('/') ? path : `/${path}`, origin);
}
