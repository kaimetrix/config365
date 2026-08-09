import 'server-only';

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { readdir, readFile } from 'fs/promises';

import * as gitea from './gitea';
import type { ScriptFileChange } from './update-session';

const SCRIPTS_STAGING_DIR =
  process.env.SCRIPTS_STAGING_DIR ??
  (existsSync('/data/app/current/scripts-staging') ? '/data/app/current/scripts-staging' : '/scripts-staging');
const PIPELINE_TEMPLATES_DIR =
  process.env.PIPELINE_TEMPLATES_DIR ??
  (existsSync('/data/app/current/pipeline-templates-staging')
    ? '/data/app/current/pipeline-templates-staging'
    : '/pipeline-templates-staging');

const SKIP_EXT = new Set(['.exe', '.dll', '.bin']);

function gitBlobSha(buf: Buffer): string {
  const header = Buffer.from(`blob ${buf.byteLength}\0`);
  return createHash('sha1').update(header).update(buf).digest('hex');
}

async function walkDir(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await walkDir(full));
    else if (entry.isFile()) {
      const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase() : '';
      if (SKIP_EXT.has(ext)) continue;
      results.push(full);
    }
  }
  return results;
}

async function collectStagingFiles(): Promise<Array<{ relPath: string; content: string }>> {
  const out: Array<{ relPath: string; content: string }> = [];

  if (existsSync(SCRIPTS_STAGING_DIR)) {
    const files = await walkDir(SCRIPTS_STAGING_DIR);
    for (const localPath of files) {
      const relPath = relative(SCRIPTS_STAGING_DIR, localPath).split(sep).join('/');
      const content = (await readFile(localPath)).toString('utf-8');
      out.push({ relPath, content });
    }
  }

  const workflowMap: Record<string, string> = {
    'backup-pipeline.yml': '.gitea/workflows/backup-pipeline.yml',
    'deploy-pipeline.yml': '.gitea/workflows/deploy-pipeline.yml',
    'maintenance-pipeline.yml': '.gitea/workflows/maintenance-pipeline.yml',
    'engine-sync.yml': 'engine-workflows/sync-workflows.yml',
  };

  if (existsSync(PIPELINE_TEMPLATES_DIR)) {
    for (const [local, giteaPath] of Object.entries(workflowMap)) {
      const localPath = join(PIPELINE_TEMPLATES_DIR, local);
      if (!existsSync(localPath)) continue;
      out.push({ relPath: giteaPath, content: (await readFile(localPath)).toString('utf-8') });
    }
  }

  return out;
}

export async function diffScriptsAgainstOrchestrator(): Promise<{
  toUpload: Array<{ relPath: string; content: string; remoteSha?: string }>;
  changes: ScriptFileChange[];
}> {
  const org = gitea.defaultOrg();
  const repo = 'orchestrator';
  const existingEntries = await gitea.getGitTree(org, repo).catch(() => [] as gitea.GitTreeEntry[]);
  const existingShaMap = new Map(existingEntries.map(e => [e.path, e.sha]));

  const stagingFiles = await collectStagingFiles();
  const toUpload: Array<{ relPath: string; content: string; remoteSha?: string }> = [];
  const changes: ScriptFileChange[] = [];

  for (const f of stagingFiles) {
    const buf = Buffer.from(f.content, 'utf-8');
    const localSha = gitBlobSha(buf);
    const remoteSha = existingShaMap.get(f.relPath);
    if (remoteSha === localSha) continue;

    let oldContent: string | undefined;
    if (remoteSha) {
      const existing = await gitea.getFile(org, repo, f.relPath).catch(() => ({ exists: false, content: '' }));
      if (existing.exists) oldContent = existing.content;
    }

    toUpload.push({ relPath: f.relPath, content: f.content, remoteSha });
    changes.push({
      path: f.relPath,
      status: remoteSha ? 'modified' : 'added',
      oldContent,
      newContent: f.content,
    });
  }

  return { toUpload, changes };
}

export interface ScriptsPrResult {
  prNumber: number;
  prUrl: string;
  branch: string;
  changedFiles: ScriptFileChange[];
}

export async function proposeScriptsUpdatePR(appVersion: string): Promise<ScriptsPrResult | null> {
  const org = gitea.defaultOrg();
  const repo = 'orchestrator';
  const { toUpload, changes } = await diffScriptsAgainstOrchestrator();
  if (toUpload.length === 0) return null;

  const branch = `updates/scripts-v${appVersion.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
  await gitea.createBranch(org, repo, branch);

  await gitea.batchPutFiles(
    org, repo,
    toUpload.map(f => ({ path: f.relPath, content: f.content })),
    `Update scripts to v${appVersion}`,
    branch,
  );

  const pr = await gitea.createPullRequest(org, repo, {
    title: `Update scripts to v${appVersion}`,
    head: branch,
    base: 'main',
    body: `Automated script update from Config365 app release v${appVersion}.\n\n${toUpload.length} file(s) changed.`,
  });

  const baseUrl = process.env.NODE_ENV === 'production' ? '/gitea' : (process.env.GITEA_INTERNAL_URL ?? 'http://127.0.0.1:3000');
  return {
    prNumber: pr.number,
    prUrl: `${baseUrl}/${org}/${repo}/pulls/${pr.number}`,
    branch,
    changedFiles: changes,
  };
}

export async function mergeScriptsPullRequest(prNumber: number): Promise<void> {
  const org = gitea.defaultOrg();
  await gitea.mergePullRequest(org, 'orchestrator', prNumber);
}

export async function closeScriptsPullRequest(prNumber: number): Promise<void> {
  const org = gitea.defaultOrg();
  await gitea.updatePullRequest(org, 'orchestrator', prNumber, { state: 'closed' });
}
