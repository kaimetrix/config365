/**
 * token-api-server.ts — Standalone internal token management API.
 *
 * Built as a separate entry point (esbuild → token-api-server.mjs).
 * Managed by supervisord as [program:token-api] on port 4322.
 * Not part of the Next.js app router — never bundled with the portal.
 *
 * Security:
 *   - Listens only on localhost inside the AIO container (not exposed on host ports)
 *   - Every request must carry Authorization: Bearer <MSP_PORTAL_INTERNAL_KEY>
 *   - The key is stored per-MSP in platform_settings (config365.db), not as a global env var
 *   - Token values never appear in logs or error responses
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import {
  startDeviceCodeFlow,
  pollDeviceCodeFlow,
  getOrRefreshTenantToken,
  getExchangeTenantToken,
  getSharePointTenantToken,
  sharePointAdminUrlFromDomain,
  getMdeTenantToken,
  userPrincipalNameFromAccessToken,
} from './lib/tenant-auth.js';

import {
  deleteTenantTokens,
  getTenantConnectionStatus,
  getTenantCreds,
  getTenantDomain,
  getMspInternalKeyForTenant,
} from './lib/token-store.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.INTERNAL_API_PORT ?? '4322', 10);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  // Connection: close forces TCP teardown after each response.
  // Without it, PowerShell's HttpClient on Linux hangs on keep-alive connections
  // after receiving a non-2xx response, causing pipeline steps to stall for minutes.
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Connection':     'close',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Validates the Authorization header against the per-MSP internal key
 * stored in config365.db. Returns false and sends a 401 if invalid.
 *
 * The MSP key is resolved via the tenantSlug → MSP relationship in the DB,
 * so each MSP organisation gets its own isolated key.
 */
async function authenticateForTenant(
  req: IncomingMessage,
  res: ServerResponse,
  tenantSlug: string,
  mspSlugHint?: string,
): Promise<boolean> {
  const expectedKey = await getMspInternalKeyForTenant(tenantSlug, mspSlugHint);

  if (!expectedKey) {
    // When the portal already resolved the MSP, missing key means not generated —
    // not "tenant missing from token-api's DB copy".
    if (mspSlugHint) {
      json(res, 403, { error: 'msp_key_not_configured' });
      return false;
    }
    const { resolveTenantMspRowForAuth } = await import('./lib/token-store.js');
    const row = await resolveTenantMspRowForAuth(tenantSlug);
    if (!row) {
      console.error(`[token-api] tenant_not_found for slug="${tenantSlug}" (portal internal lookup)`);
      json(res, 404, {
        error: 'tenant_not_found',
        detail: `Tenant "${tenantSlug}" was not found via the portal API. MSP/tenant rows must exist in the portal (same DB the UI uses).`,
      });
      return false;
    }
    json(res, 403, { error: 'msp_key_not_configured' });
    return false;
  }

  const auth  = req.headers['authorization'] ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (bearer !== expectedKey) {
    json(res, 401, { error: 'unauthorized' });
    return false;
  }

  return true;
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url    = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path   = url.pathname;
  const method = req.method?.toUpperCase() ?? 'GET';

  // Health check — no auth required
  if (method === 'GET' && path === '/health') {
    return json(res, 200, { ok: true });
  }

  try {
    // POST /tenant-auth/device-start
    if (method === 'POST' && path === '/tenant-auth/device-start') {
      const body = JSON.parse(await readBody(req)) as {
        tenantSlug?: string;
        mspSlug?: string;
        tenantId?: string;
        clientId?: string;
      };
      if (!body.tenantSlug) return json(res, 400, { error: 'tenantSlug is required' });
      if (!(await authenticateForTenant(req, res, body.tenantSlug, body.mspSlug))) return;

      const hint = {
        mspSlug: body.mspSlug,
        tenantId: body.tenantId,
        clientId: body.clientId,
      };
      const result = await startDeviceCodeFlow(body.tenantSlug, hint);
      return json(res, 200, result);
    }

    // GET /tenant-auth/device-poll?tenantSlug=&mspSlug=
    if (method === 'GET' && path === '/tenant-auth/device-poll') {
      const tenantSlug = url.searchParams.get('tenantSlug');
      const mspSlug = url.searchParams.get('mspSlug') ?? undefined;
      if (!tenantSlug) return json(res, 400, { error: 'tenantSlug query param is required' });
      if (!(await authenticateForTenant(req, res, tenantSlug, mspSlug))) return;

      const result = await pollDeviceCodeFlow(tenantSlug, { mspSlug });
      return json(res, 200, result);
    }


    // POST /tenant-auth/token  — get-or-refresh
    // Body: { tenantSlug: string, resource?: 'graph' | 'exchange' | 'mde' }
    // Default resource is 'graph'.
    //   exchange → outlook.office365.com (Exchange Online PowerShell)
    //   mde      → api.securitycenter.microsoft.com (Defender for Endpoint API)
    if (method === 'POST' && path === '/tenant-auth/token') {
      const body = JSON.parse(await readBody(req)) as { tenantSlug?: string; resource?: string };
      if (!body.tenantSlug) return json(res, 400, { error: 'tenantSlug is required' });
      if (!(await authenticateForTenant(req, res, body.tenantSlug))) return;

      let accessToken: string;
      if (body.resource === 'exchange') {
        accessToken = await getExchangeTenantToken(body.tenantSlug);
        const domain = await getTenantDomain(body.tenantSlug);
        const userPrincipalName = userPrincipalNameFromAccessToken(accessToken);
        return json(res, 200, {
          accessToken,
          organizationName: domain ?? undefined,
          userPrincipalName,
        });
      } else if (body.resource === 'sharepoint') {
        accessToken = await getSharePointTenantToken(body.tenantSlug);
        const domain = await getTenantDomain(body.tenantSlug);
        return json(res, 200, {
          accessToken,
          organizationName: domain ?? undefined,
          sharePointAdminUrl: domain ? sharePointAdminUrlFromDomain(domain) ?? undefined : undefined,
        });
      } else if (body.resource === 'mde') {
        accessToken = await getMdeTenantToken(body.tenantSlug);
      } else {
        accessToken = await getOrRefreshTenantToken(body.tenantSlug);
      }
      return json(res, 200, { accessToken });
    }

    // DELETE /tenant-auth/disconnect
    if (method === 'DELETE' && path === '/tenant-auth/disconnect') {
      const body = JSON.parse(await readBody(req)) as { tenantSlug?: string };
      if (!body.tenantSlug) return json(res, 400, { error: 'tenantSlug is required' });
      if (!(await authenticateForTenant(req, res, body.tenantSlug))) return;

      const removed = await deleteTenantTokens(body.tenantSlug);
      return json(res, 200, { ok: removed });
    }

    // GET /tenant-auth/status?tenantSlug=
    if (method === 'GET' && path === '/tenant-auth/status') {
      const tenantSlug = url.searchParams.get('tenantSlug');
      if (!tenantSlug) return json(res, 400, { error: 'tenantSlug query param is required' });
      if (!(await authenticateForTenant(req, res, tenantSlug))) return;

      const status = await getTenantConnectionStatus(tenantSlug);
      return json(res, 200, status);
    }

    // GET /tenant-auth/graph-app?tenantSlug=
    // Returns the Graph app registration client ID used for this tenant (never the secret).
    // Used by Prepare-TenantRoles to resolve the deployment app SP.
    if (method === 'GET' && path === '/tenant-auth/graph-app') {
      const tenantSlug = url.searchParams.get('tenantSlug');
      if (!tenantSlug) return json(res, 400, { error: 'tenantSlug query param is required' });
      if (!(await authenticateForTenant(req, res, tenantSlug))) return;

      const { clientId, tenantId } = await getTenantCreds(tenantSlug);
      return json(res, 200, { clientId, tenantId });
    }

    json(res, 404, { error: 'not_found' });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Never include token values in error responses
    console.error(`[token-api] ${method} ${path} error: ${message}`);
    json(res, 500, { error: 'internal_error', detail: message });
  }
}

// ─── Server startup ───────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.error('[token-api] Unhandled error:', err);
    if (!res.headersSent) json(res, 500, { error: 'internal_error' });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[token-api] Listening on 0.0.0.0:${PORT} (internal only — per-MSP key auth)`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('[token-api] Shutting down gracefully');
    process.exit(0);
  });
});
