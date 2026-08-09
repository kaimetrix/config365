import 'server-only';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export type UpdateWizardStep =
  | 'idle'
  | 'step1'
  | 'step2a'
  | 'step2b'
  | 'restarting'
  | 'step3'
  | 'step4'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface ScriptFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldContent?: string;
  newContent?: string;
}

export interface UpdateSession {
  id: string;
  targetVersion: string;
  step: UpdateWizardStep;
  startedAt: string;
  updatedAt: string;
  releaseNotes?: string;
  bumpType?: 'app' | 'platform';
  manifest?: Record<string, unknown>;
  extractPath?: string;
  schemaVersion?: number;
  migrationsApplied?: number;
  prNumber?: number;
  prUrl?: string;
  scriptChanges?: ScriptFileChange[];
  error?: string;
  log: string[];
}

const SESSION_PATH = '/data/app/update-session.json';

export function readUpdateSession(): UpdateSession | null {
  if (!existsSync(SESSION_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_PATH, 'utf-8')) as UpdateSession;
  } catch {
    return null;
  }
}

export function writeUpdateSession(session: UpdateSession): void {
  mkdirSync(dirname(SESSION_PATH), { recursive: true });
  session.updatedAt = new Date().toISOString();
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), 'utf-8');
}

export function clearUpdateSession(): void {
  if (existsSync(SESSION_PATH)) {
    writeFileSync(SESSION_PATH, '', 'utf-8');
  }
}

export function appendSessionLog(session: UpdateSession, line: string): UpdateSession {
  session.log.push(`[${new Date().toISOString()}] ${line}`);
  writeUpdateSession(session);
  return session;
}

export function createUpdateSession(targetVersion: string): UpdateSession {
  const session: UpdateSession = {
    id: `upd-${Date.now()}`,
    targetVersion,
    step: 'step1',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    log: [],
  };
  writeUpdateSession(session);
  return session;
}
