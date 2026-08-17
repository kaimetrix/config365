/**
 * Detect Gitea Actions / act_runner hangs in the implicit "Set up job" step.
 * Pure helpers — no server imports so unit tests can run without SQLite/Gitea.
 */

export const STUCK_SETUP_AFTER_MS = 3 * 60 * 1000;
export const UNSTICK_COOLDOWN_MS = 30 * 60 * 1000;

export interface StuckSetupStep {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface StuckSetupJob {
  started_at: string | null;
  status?: string;
  steps?: StuckSetupStep[];
}

export interface StuckSetupRun {
  status: string;
  created_at?: string;
}

const SETUP_STEP = /^(set[\s_-]*up[\s_-]*(job|runner)|setup[\s_-]*(job|runner))$/i;

export function isSetupStepName(name: string): boolean {
  return SETUP_STEP.test(String(name ?? '').trim());
}

function stepHasUserProgress(step: StuckSetupStep): boolean {
  if (isSetupStepName(step.name)) return false;
  const s = String(step.status ?? '').toLowerCase();
  const c = String(step.conclusion ?? '').toLowerCase();
  if (s === 'in_progress' || s === 'running' || s === 'completed') return true;
  if (c === 'success' || c === 'failure' || c === 'cancelled' || c === 'skipped') return true;
  return false;
}

function jobIsFinished(job: StuckSetupJob): boolean {
  const s = String(job.status ?? '').toLowerCase();
  return s === 'completed' || s === 'success' || s === 'failure' || s === 'cancelled' || s === 'skipped';
}

/**
 * True when a runner claimed the job but never left Set up job (or has no
 * user steps at all) for longer than the threshold.
 */
export function isStuckInSetupJob(
  run: StuckSetupRun,
  jobs: StuckSetupJob[],
  nowMs = Date.now(),
  thresholdMs = STUCK_SETUP_AFTER_MS,
): boolean {
  if (run.status !== 'running') return false;

  for (const job of jobs) {
    if (!job.started_at || jobIsFinished(job)) continue;
    if ((job.steps ?? []).some(stepHasUserProgress)) continue;
    const started = new Date(job.started_at).getTime();
    const anchor = Number.isFinite(started)
      ? started
      : (run.created_at ? new Date(run.created_at).getTime() : NaN);
    if (!Number.isFinite(anchor)) continue;
    if (nowMs - anchor > thresholdMs) return true;
  }
  return false;
}

function asStringInputs(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val == null) continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out[key] = String(val);
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Pull workflow_dispatch inputs from a raw Gitea run payload. */
export function extractDispatchInputs(raw: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!raw) return {};

  const direct = asStringInputs(raw.inputs);
  if (direct) return direct;

  const trigger = raw.trigger;
  if (trigger && typeof trigger === 'object') {
    const fromTrigger = asStringInputs((trigger as Record<string, unknown>).inputs);
    if (fromTrigger) return fromTrigger;
  }

  const payload = raw.event_payload ?? raw.eventPayload;
  if (typeof payload === 'string' && payload) {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const fromParsed = asStringInputs(parsed.inputs)
        ?? asStringInputs(parsed.workflow_dispatch);
      if (fromParsed) return fromParsed;
    } catch {
      /* ignore malformed payload */
    }
  } else if (payload && typeof payload === 'object') {
    const fromObj = asStringInputs((payload as Record<string, unknown>).inputs);
    if (fromObj) return fromObj;
  }

  return {};
}

export function workflowFileName(workflowPath: string | undefined | null): string {
  return String(workflowPath ?? '').replace(/^.*\//, '').toLowerCase();
}

/**
 * Deploy must not be re-dispatched without deploy_options (empty means no modules).
 * Backup / maintenance are safe with empty inputs (defaults / nightly-all).
 */
export function canDispatchWithoutInputs(workflowPath: string | undefined | null): boolean {
  const name = workflowFileName(workflowPath);
  return name !== 'deploy.yml' && name !== 'deploy-pipeline.yml';
}

export function canDispatchWorkflow(
  workflowPath: string | undefined | null,
  inputs: Record<string, string>,
): boolean {
  if (canDispatchWithoutInputs(workflowPath)) return true;
  return Boolean(inputs.deploy_options);
}
