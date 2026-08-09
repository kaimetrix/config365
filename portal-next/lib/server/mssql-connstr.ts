/**
 * Normalize / validate MSSQL connection strings for the Node `mssql` (tedious) driver.
 *
 * Preferred: ADO.NET key=value form (Azure Portal "ADO.NET" strings work).
 * Also accepts common hybrids such as:
 *   sqlserver://host:1433;database=db;user=u;password=p;encrypt=true
 */

export const MSSQL_CONN_PLACEHOLDER =
  'Server=sql.example.com,1433;Database=config365;User Id=sa;Password=…;Encrypt=true;TrustServerCertificate=false';

export type MssqlConnSummary = {
  server?: string;
  port?: number;
  database?: string;
  user?: string;
  passwordLength: number;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
};

export type MssqlConnNormalizeResult =
  | { ok: true; connectionString: string; summary: MssqlConnSummary; normalized: boolean }
  | { ok: false; detail: string };

/** Safe one-line message from any thrown value (never empty/undefined). */
export function errMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err instanceof Error && err.message?.trim()) return err.message.trim();
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object') {
    const o = err as {
      message?: unknown;
      code?: unknown;
      originalError?: { message?: unknown; code?: unknown; info?: { message?: unknown } };
    };
    const candidates = [
      o.originalError?.info?.message,
      o.originalError?.message,
      o.message,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    const code = typeof o.code === 'string' ? o.code : typeof o.originalError?.code === 'string' ? o.originalError.code : '';
    if (code) return `Error code ${code}`;
  }
  try {
    const s = String(err);
    if (s && s !== '[object Object]') return s;
  } catch { /* ignore */ }
  return fallback;
}

function splitSemiPairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const val = trimmed.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function first(map: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map[k];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function boolish(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (['true', 'yes', '1'].includes(s)) return true;
  if (['false', 'no', '0'].includes(s)) return false;
  return undefined;
}

function parseServerHostPort(serverRaw: string | undefined): { server?: string; port?: number } {
  if (!serverRaw) return {};
  let s = serverRaw.trim();
  // Azure Portal ADO.NET: Server=tcp:host,1433
  s = s.replace(/^tcp:/i, '');
  if (s.includes(',')) {
    const [host, portStr] = s.split(',', 2);
    const port = /^\d+$/.test(portStr.trim()) ? parseInt(portStr.trim(), 10) : undefined;
    return { server: host.trim() || undefined, port };
  }
  if (s.includes(':') && !s.includes('[')) {
    const idx = s.lastIndexOf(':');
    const host = s.slice(0, idx).trim();
    const portStr = s.slice(idx + 1).trim();
    if (/^\d+$/.test(portStr)) return { server: host || undefined, port: parseInt(portStr, 10) };
  }
  return { server: s || undefined };
}

function buildAdoNet(opts: {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  connectionTimeoutSec?: number;
}): string {
  const parts = [
    `Server=${opts.server},${opts.port}`,
    `Database=${opts.database}`,
    `User Id=${opts.user}`,
    `Password=${opts.password}`,
    `Encrypt=${opts.encrypt}`,
    `TrustServerCertificate=${opts.trustServerCertificate}`,
  ];
  if (opts.connectionTimeoutSec && opts.connectionTimeoutSec > 0) {
    parts.push(`Connection Timeout=${opts.connectionTimeoutSec}`);
  }
  return parts.join(';');
}

/**
 * Convert a hybrid `sqlserver://host:port;key=value;…` (or jdbc:sqlserver://…)
 * string into ADO.NET form. Returns null if this does not look like that hybrid.
 */
function fromSqlServerUriHybrid(input: string): string | null {
  const m = input.match(/^(?:jdbc:)?sqlserver:\/\/([^;/$?]+)(.*)$/i);
  if (!m) return null;

  const hostPart = m[1].trim();
  const rest = (m[2] ?? '').replace(/^\//, '');

  let pathDb: string | undefined;
  let query = rest;
  if (rest && !rest.startsWith(';') && !rest.startsWith('?')) {
    const qIdx = rest.search(/[;?]/);
    if (qIdx === -1) {
      pathDb = rest || undefined;
      query = '';
    } else {
      pathDb = rest.slice(0, qIdx) || undefined;
      query = rest.slice(qIdx);
    }
  }

  const pairs = splitSemiPairs(query.replace(/^\?/, '').replace(/&/g, ';'));
  const { server, port: portFromHost } = parseServerHostPort(hostPart);
  const port = portFromHost ?? (first(pairs, 'port') ? parseInt(first(pairs, 'port')!, 10) : 1433);
  const database = first(pairs, 'database', 'databasename', 'initial catalog') || pathDb;
  const user = first(pairs, 'user id', 'uid', 'user', 'username');
  const password = first(pairs, 'password', 'pwd');
  const encrypt = boolish(first(pairs, 'encrypt')) ?? true;
  const trust = boolish(first(pairs, 'trustservercertificate')) ?? false;

  if (!server || !user || password === undefined || !database) return null;

  return buildAdoNet({
    server,
    port: Number.isFinite(port) ? port : 1433,
    database,
    user,
    password,
    encrypt,
    trustServerCertificate: trust,
  });
}

/** Parse ADO.NET (or already-normalized) connection string into a summary. */
export function summarizeMssqlConnectionString(connectionString: string): MssqlConnSummary {
  const pairs = splitSemiPairs(connectionString);
  const { server, port } = parseServerHostPort(first(pairs, 'server', 'data source', 'addr', 'address', 'network address'));
  const password = first(pairs, 'password', 'pwd') ?? '';
  return {
    server,
    port: port ?? (first(pairs, 'port') ? parseInt(first(pairs, 'port')!, 10) : undefined),
    database: first(pairs, 'database', 'initial catalog'),
    user: first(pairs, 'user id', 'uid', 'user', 'username'),
    passwordLength: password.length,
    encrypt: boolish(first(pairs, 'encrypt')),
    trustServerCertificate: boolish(first(pairs, 'trustservercertificate')),
  };
}

function missingFieldsDetail(summary: MssqlConnSummary, raw: string): string {
  const missing: string[] = [];
  if (!summary.server) missing.push('Server');
  if (!summary.database) missing.push('Database');
  if (!summary.user) missing.push('User Id');
  if (!summary.passwordLength) missing.push('Password');

  const looksLikeUri = /^(?:jdbc:)?sqlserver:\/\//i.test(raw.trim());
  const parts = [
    missing.length
      ? `MSSQL connection string is missing or could not be parsed: ${missing.join(', ')}.`
      : 'MSSQL connection string could not be parsed.',
  ];
  if (looksLikeUri) {
    parts.push(
      'This looks like a sqlserver:// URI. Use ADO.NET form instead, e.g.',
      MSSQL_CONN_PLACEHOLDER,
    );
  } else {
    parts.push('Expected format:', MSSQL_CONN_PLACEHOLDER);
  }
  return parts.join(' ');
}

/**
 * Normalize (when possible) and validate a portal/token MSSQL connection string.
 * On success, `connectionString` is safe to pass to `new sql.ConnectionPool(...)`.
 */
export function normalizeMssqlConnectionString(raw: string): MssqlConnNormalizeResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, detail: 'MSSQL connection string is empty.' };
  }

  let connectionString = trimmed;
  let normalized = false;

  const hybrid = fromSqlServerUriHybrid(trimmed);
  if (hybrid) {
    connectionString = hybrid;
    normalized = true;
  } else {
    // Rewrite Azure Portal ADO.NET into a tidy Server=host,port form (strip tcp:, map Initial Catalog).
    const pairs = splitSemiPairs(trimmed);
    if (first(pairs, 'server', 'data source') || first(pairs, 'initial catalog', 'database')) {
      const { server, port } = parseServerHostPort(first(pairs, 'server', 'data source'));
      const database = first(pairs, 'database', 'initial catalog');
      const user = first(pairs, 'user id', 'uid', 'user', 'username');
      const password = first(pairs, 'password', 'pwd');
      if (server && database && user && password !== undefined) {
        const timeoutRaw = first(pairs, 'connection timeout', 'connect timeout');
        const timeoutSec = timeoutRaw && /^\d+$/.test(timeoutRaw) ? parseInt(timeoutRaw, 10) : undefined;
        connectionString = buildAdoNet({
          server,
          port: port ?? 1433,
          database,
          user,
          password,
          encrypt: boolish(first(pairs, 'encrypt')) ?? true,
          trustServerCertificate: boolish(first(pairs, 'trustservercertificate')) ?? false,
          connectionTimeoutSec: timeoutSec,
        });
        normalized = connectionString !== trimmed;
      }
    }
  }

  const summary = summarizeMssqlConnectionString(connectionString);
  if (!summary.server || !summary.database || !summary.user || !summary.passwordLength) {
    return { ok: false, detail: missingFieldsDetail(summary, trimmed) };
  }

  return { ok: true, connectionString, summary, normalized };
}

/** Human-readable MSSQL/tedious failure text with Azure-oriented hints. */
export function formatMssqlError(err: unknown, summary?: MssqlConnSummary): string {
  const e = err as Error & {
    code?: string;
    number?: number;
    state?: number;
    originalError?: Error & {
      message?: string;
      code?: string;
      info?: { number?: number; state?: number; class?: number; message?: string };
    };
  };

  const msg = errMessage(err, 'MSSQL connection failed');
  const parts: string[] = [msg];

  const code = e.code || e.originalError?.code;
  if (code) parts.push(`[${code}]`);

  const number = e.number ?? e.originalError?.info?.number;
  const state = e.state ?? e.originalError?.info?.state;
  if (number !== undefined) parts.push(`error ${number}${state !== undefined ? ` state ${state}` : ''}`);

  if (summary?.server) {
    parts.push(`(target ${summary.server}${summary.database ? `/${summary.database}` : ''}${summary.user ? ` as ${summary.user}` : ''})`);
  }

  const lower = msg.toLowerCase();
  const codeUpper = String(code ?? '').toUpperCase();
  if (lower.includes('deny public network access')) {
    parts.push(
      'Hint: Azure SQL public network access is disabled — App Service needs VNet integration + private endpoint DNS (privatelink.database.windows.net).',
    );
  } else if (lower.includes('login failed')) {
    parts.push(
      'Hint: SQL auth reached the server but was rejected — verify SQL authentication is enabled, the login exists, the password matches, and the login is mapped to the target database.',
    );
  } else if (
    codeUpper === 'ESOCKET' ||
    codeUpper === 'ETIMEOUT' ||
    codeUpper === 'ECONNREFUSED' ||
    lower.includes('failed to connect') ||
    lower.includes('could not connect') ||
    lower.includes('getaddrinfo')
  ) {
    parts.push(
      'Hint: Network path failed. For private Azure SQL: confirm App Service VNet integration, private endpoint, and privatelink DNS resolve to a 10.x address (not the public SQL VIP).',
    );
  } else if (lower.includes('config.server') || lower.includes('server property is required')) {
    parts.push(
      'Hint: Connection string was not understood by the driver. Use ADO.NET form:',
      MSSQL_CONN_PLACEHOLDER,
    );
  }

  return parts.filter(Boolean).join(' ');
}
