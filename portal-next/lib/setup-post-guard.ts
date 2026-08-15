/** Allow/deny matrix for POST /api/setup. Edge middleware cannot read SQLite. */

export type SetupPostDeny = { status: 401 | 403; error: string };

/**
 * First-run Azure may be unauthenticated (chicken-and-egg). After that a
 * session is required. After setup_complete, all POSTs are rejected.
 */
export function assertSetupPostAllowed(
  complete: boolean,
  step: string | undefined,
  hasUser: boolean,
): SetupPostDeny | null {
  if (complete) return { status: 403, error: 'Setup is already complete' };
  if (step !== 'azure' && !hasUser) return { status: 401, error: 'Unauthenticated' };
  return null;
}
