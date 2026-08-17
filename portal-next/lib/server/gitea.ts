import 'server-only';
import { writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSetting, setSetting, bootstrapGiteaToken, isRejectedRun } from './tenant-store';

const execFileAsync = promisify(execFile);

const GITEA_TOKEN_FILE =
  process.env.GITEA_TOKEN_FILE ??
  `${process.env.INIT_DATA_DIR ?? '/data/init-data'}/portal-token.txt`;

/**
 * Persist the portal token to platform_settings, portal-token.txt (used by
 * runners / entrypoint), and refresh /root git credentials for workflow clones.
 */
async function persistPortalToken(token: string): Promise<void> {
  setSetting('gitea_token', token);
  try {
    writeFileSync(GITEA_TOKEN_FILE, token, { encoding: 'utf-8', mode: 0o640 });
  } catch (err) {
    console.warn('[gitea] Failed to write portal-token.txt:', (err as Error).message);
  }
  try {
    await execFileAsync('/usr/local/bin/configure-runner-git-credentials.sh', [token], {
      timeout: 15_000,
    });
  } catch (err) {
    console.warn('[gitea] Failed to refresh runner git credentials:', (err as Error).message);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GiteaRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  empty: boolean;
}

export interface GitCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
  };
  html_url: string;
  stats?: { additions: number; deletions: number; total: number };
}

export interface GitBranch {
  name: string;
  commit: { id: string };
}

export interface WorkflowRun {
  id: number;
  name: string;
  /** Normalised status — maps Gitea's queued/in_progress/completed+conclusion to a consistent set. */
  status: 'waiting' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'blocked';
  conclusion: string | null;
  workflow_id: number;
  run_number: number;
  event: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  head_sha: string;
  head_branch: string;
  display_title?: string;
  /** The workflow filename extracted from the Gitea "path" field (e.g. "deploy.yml") */
  workflow_path?: string;
  /** Runner claimed the job but never left the implicit Set up job step. */
  stuckSetup?: boolean;
}

/** Gitea's raw API uses different status/conclusion values — normalise them. */
function normalizeRunStatus(raw: Record<string, unknown>): WorkflowRun['status'] {
  const s = raw.status as string;
  const c = (raw.conclusion as string | null) ?? null;
  if (s === 'completed') {
    if (c === 'success')   return 'success';
    if (c === 'failure')   return 'failure';
    if (c === 'cancelled') return 'cancelled';
    if (c === 'skipped')   return 'skipped';
    return 'failure';
  }
  if (s === 'queued')      return 'waiting';
  if (s === 'in_progress') return 'running';
  if (s === 'running')     return 'running';
  if (s === 'waiting')     return 'waiting';
  if (s === 'blocked')     return 'blocked';
  if (s === 'success')     return 'success';
  if (s === 'failure')     return 'failure';
  return 'waiting';
}

function normalizeRun(raw: Record<string, unknown>): WorkflowRun {
  // Gitea stores the workflow file in the "path" field as "workflow.yml@refs/heads/branch"
  const pathStr = (raw.path as string) ?? '';
  const workflowFile = pathStr.split('@')[0] ?? '';
  const runId = raw.id as number;
  let status = normalizeRunStatus(raw);
  // A portal-rejected run exits with code 1 so Gitea records conclusion:failure,
  // but it was intentionally denied — display it as cancelled, not failed.
  if (status === 'failure' && isRejectedRun(runId)) status = 'cancelled';
  return {
    id:           runId,
    name:         (raw.name as string) ?? (raw.display_title as string) ?? workflowFile ?? '',
    display_title: (raw.display_title as string) || workflowFile || undefined,
    status,
    conclusion:   (raw.conclusion as string | null) ?? null,
    workflow_id:  (raw.workflow_id as number) ?? 0,
    run_number:   (raw.run_number as number) ?? 0,
    event:        (raw.event as string) ?? '',
    html_url:     (raw.html_url as string) ?? '',
    created_at:   (raw.created_at as string) ?? (raw.started_at as string) ?? '',
    updated_at:   (raw.updated_at as string) ?? (raw.completed_at as string) ?? '',
    head_sha:     (raw.head_sha as string) ?? '',
    head_branch:  (raw.head_branch as string) ?? '',
    workflow_path: workflowFile,
  };
}

export interface WorkflowArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  archive_download_url: string;
  created_at: string;
}

export interface GiteaSecret {
  name: string;
  created_at: string;
  updated_at: string;
}

export interface FileContent {
  content: string;
  encoding: string;
  sha: string;
  name: string;
  path: string;
  html_url: string;
}

export interface GitTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  sha: string;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: Array<{ name: string; status: string; conclusion: string | null; number: number }>;
}

export interface GiteaOrg {
  id: number;
  username: string;
  full_name: string;
  visibility: string;
}

export interface GiteaRunner {
  id: number;
  name: string;
  status: string;
  os: string;
  version: string;
  labels: { id: number; name: string; type: string }[];
}

// ─── Client ───────────────────────────────────────────────────────────────────

export function getBaseUrl(): string {
  return (
    process.env.GITEA_INTERNAL_URL ??
    process.env.GITEA_BASE_URL ??
    'http://127.0.0.1:3000'
  ).replace(/\/$/, '');
}

export function getToken(): string {
  const dbToken = getSetting('gitea_token');
  if (dbToken) return dbToken;

  const envToken = process.env.GITEA_TOKEN;
  if (envToken) return envToken;

  if (bootstrapGiteaToken() === 'ok') {
    const bootstrapped = getSetting('gitea_token');
    if (bootstrapped) return bootstrapped;
  }

  throw new Error('Gitea token not configured. Ensure the Gitea init container completed successfully.');
}

async function giteaFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${getBaseUrl()}/api/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${getToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gitea API error ${res.status} ${res.statusText} — ${path}: ${body}`);
  }

  if (res.status === 204) return undefined as unknown as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ─── Admin ────────────────────────────────────────────────────────────────────

const GITEA_ADMIN_USER = process.env.GITEA_ADMIN_USER ?? 'config365-admin';

export async function resetGiteaAdminPassword(newPassword: string): Promise<void> {
  await giteaFetch(`/admin/users/${encodeURIComponent(GITEA_ADMIN_USER)}`, {
    method: 'PATCH',
    body: JSON.stringify({ login_name: GITEA_ADMIN_USER, source_id: 0, password: newPassword, must_change_password: false }),
  });
  // Store password so generateGiteaPortalToken() can use Basic Auth later
  setSetting('gitea_admin_password', newPassword);
}

/**
 * Creates a Gitea personal access token via Basic Auth and stores it.
 * Returns the new token, or null if Basic Auth / token creation failed.
 */
async function createPortalTokenWithPassword(password: string): Promise<string | null> {
  const base = getBaseUrl();
  const basicAuth = Buffer.from(`${GITEA_ADMIN_USER}:${password}`).toString('base64');
  const headers = {
    Authorization: `Basic ${basicAuth}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Unique name so recreation isn't blocked by a leftover token of the same name
  const tokenName = `config365-portal-${Date.now().toString(36)}`;

  // Best-effort cleanup of the legacy fixed-name token
  await fetch(`${base}/api/v1/users/${encodeURIComponent(GITEA_ADMIN_USER)}/tokens/config365-portal`, {
    method: 'DELETE', headers,
  }).catch(() => {});

  const tryCreate = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/v1/users/${encodeURIComponent(GITEA_ADMIN_USER)}/tokens`, {
      method: 'POST', headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[gitea] Basic-auth token create failed (${res.status}): ${text.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as { sha1?: string; token?: string };
    return data.sha1 ?? data.token ?? null;
  };

  // Prefer scoped token (Gitea 1.19+); fall back to unscoped for older installs
  let newToken =
    (await tryCreate({ name: tokenName, scopes: ['all'] })) ??
    (await tryCreate({ name: tokenName }));

  if (!newToken) return null;
  await persistPortalToken(newToken);
  return newToken;
}

/**
 * Generates a fresh "config365-portal" API token for the Gitea admin user and
 * persists it as the active portal token.
 *
 * Strategy (in order):
 *  1. Use the stored admin password (set via Reset Admin Password) for Basic Auth
 *  2. Force-sync from /init-data/portal-token.txt and validate it
 *  3. Clear guidance if both fail
 */
export async function generateGiteaPortalToken(): Promise<string> {
  const storedPassword = getSetting('gitea_admin_password');

  if (storedPassword) {
    const created = await createPortalTokenWithPassword(storedPassword);
    if (created) return created;
    // Password may be stale — fall through to file sync
  }

  // Force-read the init-data file (do not keep a stale DB token that happens to exist)
  const { bootstrapGiteaToken: sync } = await import('./tenant-store');
  const result = sync(true);
  if (result === 'ok') {
    const synced = getSetting('gitea_token');
    if (synced) {
      const login = await testGiteaToken(synced);
      if (login) return synced;
    }
  }

  throw new Error(
    'Could not generate a Gitea API token. ' +
    'Reset the Gitea admin password in Platform Admin (so Basic Auth works), then click Generate new token again. ' +
    'Alternatively restart the app so init recreates /init-data/portal-token.txt, then use Sync from file.'
  );
}

export function getGiteaAdminUser(): string { return GITEA_ADMIN_USER; }

/**
 * Test whether a raw Gitea token authenticates successfully.
 * Returns the login name of the authenticated user, or null if the token is invalid.
 */
export async function testGiteaToken(rawToken: string): Promise<string | null> {
  try {
    const url = `${getBaseUrl()}/api/v1/user`;
    const res = await fetch(url, {
      headers: { Authorization: `token ${rawToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { login?: string };
    return data.login ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate a raw Gitea token then persist it as the active portal token.
 * Throws if the token is rejected by Gitea.
 */
export async function applyGiteaToken(rawToken: string): Promise<void> {
  const login = await testGiteaToken(rawToken);
  if (!login) throw new Error('Token is invalid — Gitea rejected it.');
  await persistPortalToken(rawToken);
}

// ─── Repos ────────────────────────────────────────────────────────────────────

export async function listTenantRepos(org: string): Promise<GiteaRepo[]> {
  const repos = await giteaFetch<GiteaRepo[]>(`/orgs/${encodeURIComponent(org)}/repos?limit=50&type=source`);
  return repos.filter((r) => r.name.startsWith('tenant-') && r.name !== 'tenant-template');
}

export async function getRepo(owner: string, repo: string): Promise<GiteaRepo> {
  return giteaFetch<GiteaRepo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

export async function createRepo(org: string, name: string, opts: { description?: string; private?: boolean; autoInit?: boolean } = {}): Promise<GiteaRepo> {
  return giteaFetch<GiteaRepo>(`/orgs/${encodeURIComponent(org)}/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: opts.description ?? '',
      private:    opts.private  ?? true,
      auto_init:  opts.autoInit ?? false,
    }),
  });
}

export async function forkRepo(templateOwner: string, templateRepo: string, org: string, newName: string): Promise<GiteaRepo> {
  return giteaFetch<GiteaRepo>(
    `/repos/${encodeURIComponent(templateOwner)}/${encodeURIComponent(templateRepo)}/forks`,
    { method: 'POST', body: JSON.stringify({ organization: org, name: newName }) }
  );
}

/**
 * Creates a new repo by generating from a Gitea template repo.
 * Unlike forkRepo, this can be called multiple times from the same org
 * (Gitea allows only one fork per org, but unlimited template generates).
 * Requires the source repo to have `is_template: true` set.
 */
export async function generateFromTemplate(
  templateOwner: string,
  templateRepo: string,
  owner: string,
  newName: string,
  opts: { description?: string; private?: boolean } = {},
): Promise<GiteaRepo> {
  return giteaFetch<GiteaRepo>(
    `/repos/${encodeURIComponent(templateOwner)}/${encodeURIComponent(templateRepo)}/generate`,
    {
      method: 'POST',
      body: JSON.stringify({
        owner:       owner,
        name:        newName,
        description: opts.description ?? '',
        private:     opts.private ?? true,
        git_content: true,
      }),
    }
  );
}

export async function enableRepoActions(owner: string, repo: string): Promise<void> {
  await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    method: 'PATCH', body: JSON.stringify({ has_actions: true }),
  });
}

export async function enableRepoIssues(owner: string, repo: string): Promise<void> {
  await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    method: 'PATCH', body: JSON.stringify({ has_issues: true }),
  });
}

export async function markRepoAsTemplate(owner: string, repo: string): Promise<void> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  // Gitea 1.26 EditRepoOption uses "template", not "is_template"
  await giteaFetch<void>(path, { method: 'PATCH', body: JSON.stringify({ template: true }) });
}

export async function deleteRepo(owner: string, repo: string): Promise<void> {
  await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { method: 'DELETE' });
}

export async function repoExists(owner: string, repo: string): Promise<boolean> {
  try { await getRepo(owner, repo); return true; } catch { return false; }
}

// ─── Git — commits ─────────────────────────────────────────────────────────────

export async function getCommits(owner: string, repo: string, opts: { branch?: string; limit?: number; page?: number } = {}): Promise<GitCommit[]> {
  const params = new URLSearchParams({ sha: opts.branch ?? 'main', limit: String(opts.limit ?? 50), page: String(opts.page ?? 1) });
  try {
    return await giteaFetch<GitCommit[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${params}`);
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('409') || msg.toLowerCase().includes('empty')) return [];
    throw err;
  }
}

export async function getCommit(owner: string, repo: string, sha: string): Promise<GitCommit> {
  return giteaFetch<GitCommit>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${sha}`);
}

export async function getBranches(owner: string, repo: string): Promise<GitBranch[]> {
  return giteaFetch<GitBranch[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
}

// ─── Git — files ──────────────────────────────────────────────────────────────

export async function getFile(owner: string, repo: string, filePath: string, ref?: string): Promise<{ content: string; sha: string; exists: true } | { exists: false }> {
  const params = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  try {
    const data = await giteaFetch<FileContent>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}${params}`);
    const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
    return { content, sha: data.sha, exists: true };
  } catch (err: unknown) {
    if ((err as Error)?.message?.includes('404')) return { exists: false };
    throw err;
  }
}

export async function getBinaryFile(owner: string, repo: string, filePath: string, ref?: string): Promise<{ contentBase64: string; sha: string; exists: true } | { exists: false }> {
  const params = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  try {
    const data = await giteaFetch<FileContent>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}${params}`);
    return { contentBase64: data.content.replace(/\n/g, ''), sha: data.sha, exists: true };
  } catch (err: unknown) {
    if ((err as Error)?.message?.includes('404')) return { exists: false };
    throw err;
  }
}

export async function putFile(owner: string, repo: string, filePath: string, content: string, message: string, sha?: string, branch = 'main', isBase64 = false): Promise<void> {
  const contentBase64 = isBase64 ? content : Buffer.from(content, 'utf-8').toString('base64');
  await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}`, {
    method: sha ? 'PUT' : 'POST',
    body: JSON.stringify({ message, content: contentBase64, sha, branch, author: { name: 'Config365 Portal', email: 'portal@config365.local' } }),
  });
}

export async function deleteFile(owner: string, repo: string, filePath: string, sha: string, message: string, branch = 'main'): Promise<void> {
  await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch, author: { name: 'Config365 Portal', email: 'portal@config365.local' } }),
  });
}

export async function getTree(owner: string, repo: string, dirPath = '', ref = 'main'): Promise<TreeEntry[]> {
  const encodedPath = dirPath
    ? `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${dirPath}?ref=${encodeURIComponent(ref)}`
    : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?ref=${encodeURIComponent(ref)}`;
  try {
    const data = await giteaFetch<unknown[]>(encodedPath);
    if (!Array.isArray(data)) return [];
    return data.map((item: unknown) => {
      const i = item as Record<string, unknown>;
      return { name: String(i.name), path: String(i.path), type: i.type === 'dir' ? 'dir' : 'file', size: (i.size as number) ?? 0, sha: String(i.sha) };
    });
  } catch (err: unknown) {
    if ((err as Error)?.message?.includes('404')) return [];
    throw err;
  }
}

async function listGitTreeBlobs(
  owner: string,
  repo: string,
  treeSha: string,
  pathPrefix = '',
): Promise<GitTreeEntry[]> {
  const data = await giteaFetch<{ tree: GitTreeEntry[] }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${treeSha}`,
  );

  const blobs: GitTreeEntry[] = [];
  const subtrees: { sha: string; path: string }[] = [];

  for (const entry of data.tree ?? []) {
    const fullPath = pathPrefix ? `${pathPrefix}/${entry.path}` : entry.path;
    if (entry.type === 'blob') {
      blobs.push({ ...entry, path: fullPath });
    } else if (entry.type === 'tree') {
      subtrees.push({ sha: entry.sha, path: fullPath });
    }
  }

  const SUBTREE_CONCURRENCY = 8;
  for (let i = 0; i < subtrees.length; i += SUBTREE_CONCURRENCY) {
    const batch = subtrees.slice(i, i + SUBTREE_CONCURRENCY);
    const nested = await Promise.all(
      batch.map(st => listGitTreeBlobs(owner, repo, st.sha, st.path)),
    );
    for (const items of nested) blobs.push(...items);
  }

  return blobs;
}

export async function getGitTree(owner: string, repo: string, ref = 'main'): Promise<GitTreeEntry[]> {
  try {
    const branch = await giteaFetch<{ commit: { id: string } }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(ref)}`);
    const commitSha = branch.commit.id;
    const tree = await giteaFetch<{ tree: GitTreeEntry[]; truncated: boolean }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${commitSha}?recursive=1`);
    if (!tree.truncated) {
      return (tree.tree ?? []).filter(e => e.type === 'blob');
    }

    // Gitea caps recursive trees at 1000 entries — walk each subtree instead.
    return listGitTreeBlobs(owner, repo, commitSha);
  } catch (err: unknown) {
    if ((err as Error)?.message?.includes('404')) return [];
    throw err;
  }
}

// ─── Actions — workflow runs ───────────────────────────────────────────────────

export async function getWorkflowRuns(owner: string, repo: string, opts: { workflowId?: number | string; limit?: number } = {}): Promise<WorkflowRun[]> {
  // Gitea ignores the workflow_id query param — fetch more runs and filter client-side by path.
  const fetchLimit = opts.workflowId ? Math.max((opts.limit ?? 1) * 20, 40) : (opts.limit ?? 20);
  const params = new URLSearchParams({ limit: String(fetchLimit) });
  const data = await giteaFetch<{ workflow_runs: Record<string, unknown>[] }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?${params}`);
  let runs = (data.workflow_runs ?? []).map(normalizeRun);

  // Filter by workflow file if requested
  if (opts.workflowId) {
    const wf = String(opts.workflowId).replace(/^.*\//, ''); // strip path prefix, keep "deploy.yml"
    runs = runs.filter(r => r.workflow_path === wf || r.workflow_path === opts.workflowId);
  }

  // Apply limit after filtering
  if (opts.limit) runs = runs.slice(0, opts.limit);
  return runs;
}

export async function getWorkflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRun> {
  const raw = await giteaFetch<Record<string, unknown>>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`);
  return normalizeRun(raw);
}

export async function getWorkflowRunRaw(owner: string, repo: string, runId: number): Promise<Record<string, unknown>> {
  return giteaFetch<Record<string, unknown>>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`);
}

export async function triggerWorkflow(owner: string, repo: string, workflowFile: string, ref = 'main', inputs: Record<string, string> = {}): Promise<void> {
  await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, {
    method: 'POST', body: JSON.stringify({ ref, inputs }),
  });
}

export async function cancelWorkflowRun(owner: string, repo: string, runId: number): Promise<void> {
  await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/cancel`, { method: 'POST' });
}

/** Official rerun API is newer than Gitea 1.26.1 — returns false on 404/405. */
export async function rerunWorkflowRun(owner: string, repo: string, runId: number): Promise<boolean> {
  try {
    await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/rerun`, { method: 'POST' });
    return true;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/\b40[45]\b/.test(msg)) return false;
    throw err;
  }
}

export async function getRunLogs(owner: string, repo: string, runId: number): Promise<string> {
  return `${getBaseUrl()}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/logs`;
}

export async function getArtifacts(owner: string, repo: string, runId: number): Promise<WorkflowArtifact[]> {
  const data = await giteaFetch<{ artifacts: WorkflowArtifact[] }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/artifacts`);
  return data.artifacts ?? [];
}

export async function downloadArtifact(artifactDownloadUrl: string): Promise<Buffer> {
  const res = await fetch(artifactDownloadUrl, { headers: { Authorization: `token ${getToken()}` } });
  if (!res.ok) throw new Error(`Artifact download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function getRunJobs(owner: string, repo: string, runId: number): Promise<WorkflowJob[]> {
  try {
    const data = await giteaFetch<{ jobs: WorkflowJob[] }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs`);
    return data.jobs ?? [];
  } catch { return []; }
}

// ─── Secrets ──────────────────────────────────────────────────────────────────

export async function setOrgSecret(org: string, name: string, value: string): Promise<void> {
  await giteaFetch<void>(`/orgs/${encodeURIComponent(org)}/actions/secrets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ data: value }) });
}

export async function setRepoSecret(owner: string, repo: string, name: string, value: string): Promise<void> {
  await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ data: value }) });
}

export async function listRepoSecrets(owner: string, repo: string): Promise<GiteaSecret[]> {
  const data = await giteaFetch<{ data: GiteaSecret[] }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets`);
  return data.data ?? [];
}

export async function listOrgSecrets(org: string): Promise<GiteaSecret[]> {
  try {
    const raw = await giteaFetch<GiteaSecret[] | { data: GiteaSecret[] }>(`/orgs/${encodeURIComponent(org)}/actions/secrets`);
    return Array.isArray(raw) ? raw : (raw as { data: GiteaSecret[] }).data ?? [];
  } catch { return []; }
}

export async function setOrgVariable(org: string, name: string, value: string): Promise<void> {
  try {
    await giteaFetch<void>(`/orgs/${encodeURIComponent(org)}/actions/variables/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ name, value }) });
  } catch {
    await giteaFetch<void>(`/orgs/${encodeURIComponent(org)}/actions/variables/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ name, value }) });
  }
}

export async function setRepoVariable(owner: string, repo: string, name: string, value: string): Promise<void> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/variables/${encodeURIComponent(name)}`;
  try {
    await giteaFetch<void>(path, { method: 'PUT', body: JSON.stringify({ name, value }) });
  } catch {
    await giteaFetch<void>(path, { method: 'POST', body: JSON.stringify({ name, value }) });
  }
}

// ─── Branch protection ────────────────────────────────────────────────────────

export async function enforceBranchProtection(owner: string, repo: string, branch = 'main'): Promise<void> {
  const botUser = process.env.GITEA_ADMIN_USER ?? 'config365-admin';
  const rule = { branch_name: branch, enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: [botUser], push_whitelist_deploy_keys: false, required_approvals: 1, block_on_rejected_reviews: true, dismiss_stale_approvals: true, block_on_outdated_branch: false };
  await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branch_protections`, { method: 'POST', body: JSON.stringify(rule) })
    .catch(async (err: Error) => {
      if (err.message?.includes('422')) {
        const { branch_name: _, ...patch } = rule;
        await giteaFetch<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branch_protections/${branch}`, { method: 'PATCH', body: JSON.stringify(patch) });
      } else { throw err; }
    });
}

// ─── Organisations ────────────────────────────────────────────────────────────

export async function orgExists(org: string): Promise<boolean> {
  try { await giteaFetch<GiteaOrg>(`/orgs/${encodeURIComponent(org)}`); return true; } catch { return false; }
}

export async function createOrg(org: string, opts: { fullName?: string; description?: string; visibility?: 'public' | 'limited' | 'private' } = {}): Promise<GiteaOrg> {
  return giteaFetch<GiteaOrg>('/orgs', {
    method: 'POST',
    body: JSON.stringify({ username: org, full_name: opts.fullName ?? org, description: opts.description ?? '', visibility: opts.visibility ?? 'private' }),
  });
}

// ─── Runners ─────────────────────────────────────────────────────────────────

export async function listOrgRunners(org: string): Promise<GiteaRunner[]> {
  try {
    const data = await giteaFetch<{ runners: GiteaRunner[] }>(`/orgs/${encodeURIComponent(org)}/actions/runners`);
    return data.runners ?? [];
  } catch { return []; }
}

export async function deleteOrgRunner(org: string, runnerId: number): Promise<void> {
  await giteaFetch<void>(`/orgs/${encodeURIComponent(org)}/actions/runners/${runnerId}`, { method: 'DELETE' });
}

export async function getRunnerRegistrationToken(org: string): Promise<string> {
  const data = await giteaFetch<{ token: string }>(`/orgs/${encodeURIComponent(org)}/actions/runners/registration-token`, { method: 'POST' });
  return data.token;
}

export async function getInstanceRunnerRegistrationToken(): Promise<string> {
  const data = await giteaFetch<{ token: string }>(`/admin/runners/registration-token`, { method: 'POST' });
  return data.token;
}

// ─── Commit diff / file changes ──────────────────────────────────────────────

export interface CommitFileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch: string; // unified diff hunk for this file
}

export interface CommitDiff {
  sha: string;
  parentSha: string | null;
  files: CommitFileChange[];
}

type GiteaCommitFile = {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
};

function mapFileStatus(status: string | undefined): CommitFileChange['status'] {
  switch (status?.toLowerCase()) {
    case 'added': return 'added';
    case 'removed':
    case 'deleted': return 'removed';
    case 'renamed': return 'renamed';
    default: return 'modified';
  }
}

function mapGiteaFiles(raw: GiteaCommitFile[] | undefined): CommitFileChange[] {
  return (raw ?? []).map(f => ({
    filename:  f.filename ?? '',
    status:    mapFileStatus(f.status),
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    patch:     f.patch ?? '',
  }));
}

function extractParentSha(commitDetail: Record<string, unknown>): string | null {
  const parents = commitDetail.parents as Array<Record<string, string>> | undefined;
  if (parents?.[0]) return parents[0].sha ?? parents[0].id ?? null;
  const nested = (commitDetail.commit as Record<string, unknown> | undefined)?.parents;
  if (Array.isArray(nested) && nested[0]) {
    const p = nested[0] as Record<string, string>;
    return p.sha ?? p.id ?? null;
  }
  return null;
}

type GiteaCommitDetail = {
  sha: string;
  files?: GiteaCommitFile[];
  parents?: Array<{ sha?: string; id?: string }>;
  commit?: { parents?: Array<{ sha?: string }> };
};

/** Fetch a single commit with changed files. Tries /git/commits first (Gitea 1.22+), then /commits. */
async function fetchCommitWithFiles(owner: string, repo: string, sha: string): Promise<GiteaCommitDetail> {
  const ownerEnc = encodeURIComponent(owner);
  const repoEnc  = encodeURIComponent(repo);
  const shaEnc   = encodeURIComponent(sha);

  // Primary: low-level git commit endpoint — includes files[] on this Gitea version
  try {
    return await giteaFetch<GiteaCommitDetail>(
      `/repos/${ownerEnc}/${repoEnc}/git/commits/${shaEnc}`,
    );
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (!msg.includes('404')) throw err;
  }

  // Fallback: GitHub-compatible repo commit endpoint (some Gitea builds)
  return giteaFetch<GiteaCommitDetail>(
    `/repos/${ownerEnc}/${repoEnc}/commits/${shaEnc}`,
  );
}

function extractCompareFiles(compareData: {
  files?: GiteaCommitFile[];
  commits?: Array<{ files?: GiteaCommitFile[] }>;
}): GiteaCommitFile[] {
  if (compareData.files?.length) return compareData.files;
  return compareData.commits?.flatMap(c => c.files ?? []) ?? [];
}

/**
 * Returns file-level changes for a single commit.
 * Primary source: Gitea GET /git/commits/{sha} files[] (or /commits/{sha} on older builds).
 * Compare endpoint enriches patches when missing.
 */
export async function getCommitDiff(owner: string, repo: string, sha: string): Promise<CommitDiff> {
  const commitDetail = await fetchCommitWithFiles(owner, repo, sha);

  const detail = commitDetail as Record<string, unknown>;
  const parentSha = extractParentSha(detail);
  let files = mapGiteaFiles(commitDetail.files);

  if (parentSha) {
    try {
      const compareBase = `${encodeURIComponent(parentSha)}...${encodeURIComponent(sha)}`;
      const compareData = await giteaFetch<{
        files?: GiteaCommitFile[];
        commits?: Array<{ files?: GiteaCommitFile[] }>;
      }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${compareBase}`);

      const compareFiles = extractCompareFiles(compareData);
      if (files.length === 0 && compareFiles.length > 0) {
        files = mapGiteaFiles(compareFiles);
      } else if (compareFiles.length > 0) {
        const patches = new Map(compareFiles.map(f => [f.filename ?? '', f.patch ?? '']));
        files = files.map(f => ({
          ...f,
          patch: f.patch || patches.get(f.filename) || '',
        }));
      }
    } catch {
      // Keep files parsed from commit detail
    }
  }

  return { sha, parentSha, files };
}

// ─── Batch file push (single commit) ─────────────────────────────────────────

export interface BatchFileEntry {
  path:    string;
  content: string; // UTF-8 text, or base64 when encoding is 'base64'
  encoding?: 'utf-8' | 'base64';
}

/**
 * Push multiple files to a repo in one or more atomic commits via Gitea REST API.
 *
 * Uses POST /repos/{owner}/{repo}/contents (multi-file ChangeFilesOptions).
 * The low-level Git data API (POST /git/blobs) is not available on Gitea 1.26.
 */
export async function batchPutFiles(
  owner:   string,
  repo:    string,
  files:   BatchFileEntry[],
  message: string,
  branch = 'main',
  onBlobProgress?: (completed: number, total: number) => void,
): Promise<void> {
  if (files.length === 0) return;

  const ownerEnc = encodeURIComponent(owner);
  const repoEnc  = encodeURIComponent(repo);
  const author = { name: 'Config365 Portal', email: 'portal@config365.local' };
  const CHUNK = 100;
  const parts = Math.ceil(files.length / CHUNK);

  for (let i = 0; i < files.length; i += CHUNK) {
    const slice = files.slice(i, i + CHUNK);
    const partNum = Math.floor(i / CHUNK) + 1;
    const partMsg = parts > 1 ? `${message} (part ${partNum}/${parts})` : message;

    await giteaFetch(
      `/repos/${ownerEnc}/${repoEnc}/contents`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: partMsg,
          branch,
          author,
          committer: author,
          files: slice.map((file) => ({
            operation: 'upload',
            path: file.path,
            content: file.encoding === 'base64'
              ? file.content
              : Buffer.from(file.content, 'utf-8').toString('base64'),
          })),
        }),
      },
    );

    onBlobProgress?.(Math.min(i + slice.length, files.length), files.length);
  }
}

// ─── Pull requests ────────────────────────────────────────────────────────────

export interface GiteaPullRequest {
  number: number;
  title: string;
  state: string;
  html_url?: string;
  url?: string;
}

export async function createBranch(owner: string, repo: string, newBranch: string, oldBranch = 'main'): Promise<void> {
  const ownerEnc = encodeURIComponent(owner);
  const repoEnc = encodeURIComponent(repo);
  await giteaFetch(`/repos/${ownerEnc}/${repoEnc}/branches`, {
    method: 'POST',
    body: JSON.stringify({ new_branch_name: newBranch, old_branch_name: oldBranch }),
  });
}

export async function createPullRequest(
  owner: string,
  repo: string,
  opts: { title: string; head: string; base: string; body?: string },
): Promise<GiteaPullRequest> {
  const ownerEnc = encodeURIComponent(owner);
  const repoEnc = encodeURIComponent(repo);
  return giteaFetch<GiteaPullRequest>(`/repos/${ownerEnc}/${repoEnc}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: opts.title,
      head: opts.head,
      base: opts.base,
      body: opts.body ?? '',
    }),
  });
}

export async function mergePullRequest(owner: string, repo: string, index: number): Promise<void> {
  const ownerEnc = encodeURIComponent(owner);
  const repoEnc = encodeURIComponent(repo);
  await giteaFetch(`/repos/${ownerEnc}/${repoEnc}/pulls/${index}/merge`, {
    method: 'POST',
    body: JSON.stringify({ Do: 'merge', merge_message: `Merged via Config365 update wizard` }),
  });
}

export async function updatePullRequest(
  owner: string,
  repo: string,
  index: number,
  patch: { state?: 'closed' | 'open' },
): Promise<void> {
  const ownerEnc = encodeURIComponent(owner);
  const repoEnc = encodeURIComponent(repo);
  await giteaFetch(`/repos/${ownerEnc}/${repoEnc}/pulls/${index}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// ─── Convenience ─────────────────────────────────────────────────────────────

export function tenantRepo(slug: string): string { return `tenant-${slug}`; }
export function defaultOrg(): string { return process.env.GITEA_ORG ?? 'config365'; }
