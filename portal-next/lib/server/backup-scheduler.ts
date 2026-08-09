/**
 * backup-scheduler.ts — Start the Gitea→Blob backup scheduler and run one-shot backups.
 */
import 'server-only';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { getSetting, getDecryptedSetting } from './settings-store';

const execFileAsync = promisify(execFile);

const SUPERVISORCTL = '/usr/bin/supervisorctl';
const BACKUP_SCRIPT = '/usr/local/bin/backup-gitea-blob.sh';
const LOG_DIR = '/data/logs';
const LOG_FILE = `${LOG_DIR}/gitea-backup.log`;
const HISTORY_FILE = `${LOG_DIR}/gitea-backup-history.jsonl`;
const LOCK_FILE = `${LOG_DIR}/gitea-blob-backup.lock`;
const SUPERVISORD_CONF = '/etc/supervisord.conf';

export interface BackupHistoryEntry {
  ts: string;
  archiveName: string;
  status: 'success' | 'failed' | 'running';
  sizeBytes?: number;
  error?: string;
  trigger?: 'cron' | 'manual' | string;
  container?: string;
}

export function isBlobBackupConfigured(): boolean {
  const container = getSetting('blob_storage_container');
  if (!container) return false;
  const uri = getSetting('blob_storage_uri');
  const conn = getDecryptedSetting('blob_storage_connection_string');
  return !!(uri || conn);
}

/**
 * Enable autostart and start [program:backup-scheduler] if supervisorctl is available.
 */
export async function ensureBackupSchedulerRunning(): Promise<{ started: boolean; detail: string }> {
  if (!existsSync(SUPERVISORCTL)) {
    return { started: false, detail: 'supervisorctl not available' };
  }

  await execFileAsync('sed', [
    '-i',
    '/^\\[program:backup-scheduler\\]/,/^\\[/{s/^autostart=false$/autostart=true/}',
    SUPERVISORD_CONF,
  ]).catch(() => {});

  try {
    const { stdout } = await execFileAsync(SUPERVISORCTL, ['status', 'backup-scheduler']).catch(
      (err: { stdout?: string; stderr?: string }) => ({ stdout: err.stdout ?? err.stderr ?? '' }),
    );
    if (/RUNNING/i.test(stdout)) {
      return { started: true, detail: 'Backup scheduler already running' };
    }

    await execFileAsync(SUPERVISORCTL, ['start', 'backup-scheduler']);
    return { started: true, detail: 'Backup scheduler started' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already started/i.test(msg)) {
      return { started: true, detail: 'Backup scheduler already running' };
    }
    return { started: false, detail: `Failed to start backup scheduler: ${msg}` };
  }
}

async function isBackupScriptRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'backup-gitea-blob\\.sh']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Spawn a one-shot platform Gitea→Blob backup. Returns immediately.
 */
export async function startGiteaBlobBackupNow(): Promise<{
  ok: boolean;
  detail: string;
  conflict?: boolean;
}> {
  if (!isBlobBackupConfigured()) {
    return { ok: false, detail: 'Blob Storage is not fully configured (container + URI or connection string).' };
  }
  if (!existsSync(BACKUP_SCRIPT)) {
    return { ok: false, detail: 'Backup script not found in this environment.' };
  }
  if (await isBackupScriptRunning()) {
    return { ok: false, conflict: true, detail: 'A backup is already running.' };
  }

  mkdirSync(LOG_DIR, { recursive: true });

  const cmd = [
    `C365_BACKUP_TRIGGER=manual`,
    `flock -n '${LOCK_FILE}' -c "bash '${BACKUP_SCRIPT}'"`,
    `>> '${LOG_FILE}' 2>&1`,
  ].join(' ');

  const runner = spawn('sh', ['-c', cmd], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, C365_BACKUP_TRIGGER: 'manual' },
  });
  runner.unref();

  if (runner.pid == null) {
    return { ok: false, detail: 'Failed to start backup process.' };
  }

  return {
    ok: true,
    detail: 'Platform Gitea backup started. Gitea may be briefly unavailable while the dump runs.',
  };
}

export function listGiteaBlobBackupHistory(limit = 50): BackupHistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const raw = readFileSync(HISTORY_FILE, 'utf-8');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const entries: BackupHistoryEntry[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as BackupHistoryEntry;
        if (obj && typeof obj.ts === 'string' && typeof obj.status === 'string') {
          entries.push(obj);
        }
      } catch { /* skip malformed */ }
    }
    return entries.reverse().slice(0, Math.max(1, Math.min(limit, 200)));
  } catch {
    return [];
  }
}
