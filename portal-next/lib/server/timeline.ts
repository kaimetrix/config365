import 'server-only';
import { getCommits, getCommitDiff, getFile, type GitCommit } from './gitea';
import { contentDiffers } from '../timeline-json';
export interface TimelineCommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface TimelineFileEvent {
  id: string;
  path: string;
  fileName: string;
  dirPath: string;
  changeType: 'added' | 'modified' | 'removed';
  service: string;
  commit: TimelineCommitInfo;
  prevSha: string | null;
}

export function classifyService(path: string): string {
  const p = path.toLowerCase();
  if (p.includes('entra') || p.includes('conditional-access') || p.includes('azure-ad') || p.includes('identity')) return 'entra';
  if (p.includes('intune') || p.includes('endpoint') || p.includes('compliance') || p.includes('configuration') || p.includes('app-protection') || p.includes('admx')) return 'intune';
  if (p.includes('defender') || p.includes('atp') || p.includes('mde')) return 'defender';
  if (p.includes('exchange') || p.includes('mail') || p.includes('exo')) return 'exchange';
  if (p.includes('sharepoint') || p.includes('onedrive')) return 'sharepoint';
  if (p.includes('teams')) return 'teams';
  if (p.includes('information-protection') || p.includes('purview') || p.includes('sensitivity-label')) return 'purview';
  return 'other';
}

function normalizePath(filename: string): string {
  return filename.replace(/^\//, '');
}

export function isBackupJsonFile(filename: string): boolean {
  const path = normalizePath(filename).toLowerCase();
  if (!path.startsWith('backups/')) return false;
  if (!path.endsWith('.json')) return false;
  if (path.endsWith('/backup-manifest.json') || path.endsWith('backup-manifest.json')) return false;
  return true;
}

export function buildDirPath(path: string): string {
  const norm = normalizePath(path);
  const stripped = norm.replace(/^backups\/[^/]+\//, '').replace(/\/[^/]+$/, '');
  const fileName = norm.split('/').at(-1) ?? norm;
  return stripped !== fileName ? stripped : '';
}

function mapChangeType(status: string): TimelineFileEvent['changeType'] {
  if (status === 'added') return 'added';
  if (status === 'removed') return 'removed';
  return 'modified';
}

/** Parse YYYY-MM-DD range as UTC day boundaries (matches ISO commit timestamps). */
function parseDateRange(from: string, to: string): { fromMs: number; toMs: number } {
  return {
    fromMs: Date.parse(`${from}T00:00:00.000Z`),
    toMs:   Date.parse(`${to}T23:59:59.999Z`),
  };
}

function commitInRange(c: GitCommit, fromMs: number, toMs: number): boolean {
  const t = new Date(c.commit.author.date).getTime();
  return t >= fromMs && t <= toMs;
}

function hasChanges(c: GitCommit): boolean {
  // List endpoint may omit stats on some Gitea versions — still attempt diff fetch
  if (c.stats == null) return true;
  return (c.stats.total ?? 0) > 0;
}

/** Skip "modified" files where git changed metadata but normalized JSON is identical. */
async function isMeaningfulChange(
  org: string,
  repo: string,
  path: string,
  sha: string,
  prevSha: string | null,
  changeType: TimelineFileEvent['changeType'],
  getCachedFile: (path: string, ref: string) => Promise<string | null>,
): Promise<boolean> {
  if (changeType === 'added' || changeType === 'removed') return true;
  if (!prevSha) return true;

  const [after, before] = await Promise.all([
    getCachedFile(path, sha),
    getCachedFile(path, prevSha),
  ]);
  return contentDiffers(before, after);
}

export async function buildTimelineEvents(
  org: string,
  repo: string,
  opts: { from: string; to: string; branch?: string; limit?: number },
): Promise<TimelineFileEvent[]> {
  const branch = opts.branch ?? 'main';
  const limit  = Math.min(opts.limit ?? 100, 100);
  const { fromMs, toMs } = parseDateRange(opts.from, opts.to);

  const fileCache = new Map<string, string | null>();
  async function getCachedFile(path: string, ref: string): Promise<string | null> {
    const key = `${ref}\0${path}`;
    if (fileCache.has(key)) return fileCache.get(key)!;
    const result = await getFile(org, repo, path, ref);
    const content = result.exists ? result.content : null;
    fileCache.set(key, content);
    return content;
  }

  const commits = await getCommits(org, repo, { branch, limit });
  const inRange = commits.filter(c => commitInRange(c, fromMs, toMs) && hasChanges(c));
  if (inRange.length === 0) return [];

  const BATCH = 8;
  const events: TimelineFileEvent[] = [];

  for (let i = 0; i < inRange.length; i += BATCH) {
    const batch = inRange.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async c => {
        const diff = await getCommitDiff(org, repo, c.sha);
        return { commit: c, diff };
      }),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { commit: c, diff } = r.value;

      const candidates = diff.files
        .filter(f => isBackupJsonFile(f.filename))
        .map(f => {
          const path = normalizePath(f.filename);
          return {
            path,
            fileName: path.split('/').at(-1) ?? path,
            changeType: mapChangeType(f.status),
            file: f,
          };
        });

      const FILE_BATCH = 12;
      for (let j = 0; j < candidates.length; j += FILE_BATCH) {
        const slice = candidates.slice(j, j + FILE_BATCH);
        const checked = await Promise.all(
          slice.map(async cand => ({
            cand,
            keep: await isMeaningfulChange(
              org, repo, cand.path, c.sha, diff.parentSha, cand.changeType, getCachedFile,
            ),
          })),
        );

        for (const { cand, keep } of checked) {
          if (!keep) continue;
          events.push({
            id:         `${c.sha}::${cand.path}`,
            path:       cand.path,
            fileName:   cand.fileName,
            dirPath:    buildDirPath(cand.path),
            changeType: cand.changeType,
            service:    classifyService(cand.path),
            prevSha:    diff.parentSha,
            commit: {
              sha:     c.sha,
              message: c.commit.message.split('\n')[0],
              author:  c.commit.author.name,
              date:    c.commit.author.date,
            },
          });
        }
      }
    }
  }

  return events;
}

export async function getTimelineDiff(
  org: string,
  repo: string,
  path: string,
  sha: string,
  prevSha: string | null,
  changeType: TimelineFileEvent['changeType'],
): Promise<{ before: string | null; after: string | null; changeType: TimelineFileEvent['changeType'] }> {
  const normPath = normalizePath(path);

  const [afterResult, beforeResult] = await Promise.all([
    changeType !== 'removed'
      ? getFile(org, repo, normPath, sha)
      : Promise.resolve({ exists: false as const }),
    prevSha
      ? getFile(org, repo, normPath, prevSha)
      : Promise.resolve({ exists: false as const }),
  ]);

  return {
    before: beforeResult.exists ? beforeResult.content : null,
    after:  afterResult.exists  ? afterResult.content  : null,
    changeType,
  };
}
