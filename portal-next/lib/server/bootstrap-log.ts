/**
 * In-memory bootstrap log — tracks structured step entries for all provisioning
 * operations (platform bootstrap, MSP creation, tenant creation, scripts sync).
 *
 * Designed for polling-based UI: the frontend calls GET /api/admin/platform/bootstrap-log
 * every 1.5 s and renders live progress with spinner/checkmark/X per entry.
 */

import 'server-only';
import { randomUUID } from 'node:crypto';

export type EntryStatus = 'running' | 'success' | 'error' | 'skipped';

export interface BootstrapEntry {
  id:     string;
  scope:  string;   // 'platform' | 'scripts-sync' | 'msp:<slug>' | 'tenant:<slug>'
  label:  string;
  status: EntryStatus;
  error?: string;
  ts:     number;   // ms since epoch
}

// ─── Ring buffer ─────────────────────────────────────────────────────────────

const MAX_ENTRIES = 300;
const entries: BootstrapEntry[] = [];

// Tracks which scopes currently have at least one 'running' entry
const inProgressScopes = new Set<string>();

function append(entry: BootstrapEntry) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a new step. Returns a resolve function to call when the step finishes.
 *
 * @example
 * const resolve = push('platform', 'Create orchestrator repo');
 * try { await createRepo(...); resolve('success'); }
 * catch (e) { resolve('error', e.message); }
 */
export function push(scope: string, label: string): (status: EntryStatus, error?: string) => void {
  const id = randomUUID();
  const entry: BootstrapEntry = { id, scope, label, status: 'running', ts: Date.now() };
  append(entry);
  inProgressScopes.add(scope);

  return (status: EntryStatus, error?: string) => {
    entry.status = status;
    entry.ts     = Date.now();
    if (error) entry.error = error;

    // Remove 'running' from inProgress only if no other entry for this scope is still running
    const stillRunning = entries.some(e => e.scope === scope && e.status === 'running');
    if (!stillRunning) inProgressScopes.delete(scope);
  };
}

/**
 * Mark a scope as started even before individual steps are pushed.
 * Useful for marking a scope 'in progress' at the beginning of a long operation.
 */
export function markScopeStart(scope: string) {
  inProgressScopes.add(scope);
}

/**
 * Explicitly mark a scope as finished (removes from inProgress set).
 * Call this at the very end of an operation even if all entries are already resolved,
 * to ensure the UI stops polling.
 */
export function markScopeDone(scope: string) {
  inProgressScopes.delete(scope);
}

export function getEntries(scope?: string): BootstrapEntry[] {
  if (!scope) return [...entries];
  return entries.filter(e => e.scope === scope);
}

export function isInProgress(scope: string): boolean {
  return inProgressScopes.has(scope);
}

/** Clear all entries for a scope (used before re-running an operation). */
export function clearScope(scope: string) {
  const idx = entries.reduce<number[]>((acc, e, i) => { if (e.scope === scope) acc.push(i); return acc; }, []);
  for (let i = idx.length - 1; i >= 0; i--) entries.splice(idx[i], 1);
  inProgressScopes.delete(scope);
}
