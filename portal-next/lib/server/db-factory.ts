/**
 * db-factory.ts — Returns the correct DbAdapter based on platform_settings.
 *
 * If `mssql_portal_connection_string` is stored (encrypted) in platform_settings,
 * returns the MSSQL adapter. Otherwise returns the SQLite adapter.
 *
 * The adapter is cached after first resolution. Call resetDbAdapter() to
 * force re-evaluation (e.g. after the connection string changes in the wizard).
 */
import 'server-only';

import { getDecryptedSetting } from './settings-store';
import { sqliteAdapter } from './db-sqlite';
import { createMssqlAdapter } from './db-mssql';
import type { DbAdapter } from './db-adapter';

let _adapter: DbAdapter | null = null;
let _cachedConnStr: string | null = null;

export async function getDb(): Promise<DbAdapter> {
  const connStr = getDecryptedSetting('mssql_portal_connection_string');

  // Return cached adapter if the connection string hasn't changed
  if (_adapter && _cachedConnStr === (connStr ?? '')) return _adapter;

  if (connStr) {
    _adapter = createMssqlAdapter(connStr);
    _cachedConnStr = connStr;
  } else {
    _adapter = sqliteAdapter;
    _cachedConnStr = '';
  }

  return _adapter;
}

/** Forces the factory to re-read the connection string on the next call. */
export function resetDbAdapter(): void {
  _adapter = null;
  _cachedConnStr = null;
}
