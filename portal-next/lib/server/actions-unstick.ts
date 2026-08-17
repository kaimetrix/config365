import 'server-only';
import {
  canDispatchWorkflow,
  extractDispatchInputs,
  isStuckInSetupJob,
  UNSTICK_COOLDOWN_MS,
  workflowFileName,
} from '../actions-stuck-setup';
import {
  lastWorkflowUnstickAt,
  listMsps,
  listTenants,
  recordUnstickAttempt,
  recordWorkflowUnstick,
  wasUnstickAttempted,
} from './tenant-store';
import {
  cancelWorkflowRun,
  getRunJobs,
  getWorkflowRunRaw,
  getWorkflowRuns,
  rerunWorkflowRun,
  triggerWorkflow,
  type WorkflowRun,
} from './gitea';

const WORKFLOWS = ['deploy.yml', 'backup.yml', 'maintenance.yml'] as const;
const inFlight = new Set<string>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function runKey(org: string, repo: string, runId: number): string {
  return `${org}/${repo}#${runId}`;
}

function workflowKey(org: string, repo: string, workflow: string): { org: string; repo: string; workflow: string } {
  return { org, repo, workflow: workflowFileName(workflow) || workflow };
}

export async function annotateStuckSetup(org: string, repo: string, run: WorkflowRun | null): Promise<WorkflowRun | null> {
  if (!run || run.status !== 'running') return run;
  const jobs = await getRunJobs(org, repo, run.id);
  run.stuckSetup = isStuckInSetupJob(run, jobs);
  return run;
}

/**
 * If the run is stuck in Set up job, cancel once and retry.
 * Returns whether a retry was attempted (false = flag only / already handled).
 */
export async function unstickIfNeeded(org: string, repo: string, run: WorkflowRun): Promise<boolean> {
  if (!run.stuckSetup) return false;

  const key = runKey(org, repo, run.id);
  if (inFlight.has(key) || wasUnstickAttempted(run.id)) return false;

  const wf = workflowKey(org, repo, run.workflow_path ?? '');
  const last = lastWorkflowUnstickAt(wf.org, wf.repo, wf.workflow);
  if (last != null && Date.now() - last < UNSTICK_COOLDOWN_MS) return false;

  inFlight.add(key);
  try {
    await cancelWorkflowRun(org, repo, run.id);
    recordUnstickAttempt(run.id);
    recordWorkflowUnstick(wf.org, wf.repo, wf.workflow);

    try {
      if (await rerunWorkflowRun(org, repo, run.id)) {
        console.log(`[actions-unstick] reran ${org}/${repo} run ${run.id} (${wf.workflow})`);
        return true;
      }
    } catch (err) {
      console.warn(`[actions-unstick] rerun failed for ${org}/${repo} run ${run.id}:`, (err as Error).message);
    }

    let inputs: Record<string, string> = {};
    try {
      const raw = await getWorkflowRunRaw(org, repo, run.id);
      inputs = extractDispatchInputs(raw);
    } catch {
      /* cancelled run may still return the original payload */
    }

    if (!canDispatchWorkflow(run.workflow_path, inputs)) {
      console.warn(`[actions-unstick] cancelled ${org}/${repo} run ${run.id} (${wf.workflow}) but cannot re-dispatch without inputs`);
      return false;
    }

    const file = workflowFileName(run.workflow_path) || wf.workflow;
    if (!file) return false;
    await triggerWorkflow(org, repo, file, run.head_branch || 'main', inputs);
    console.log(`[actions-unstick] dispatched ${file} for ${org}/${repo} after cancelling run ${run.id}`);
    return true;
  } catch (err) {
    console.warn(`[actions-unstick] failed for ${org}/${repo} run ${run.id}:`, (err as Error).message);
    return false;
  } finally {
    inFlight.delete(key);
  }
}

/** Annotate a running run and fire-and-forget a one-shot unstick. */
export async function annotateAndUnstick(org: string, repo: string, run: WorkflowRun | null): Promise<WorkflowRun | null> {
  startStuckSetupSweep();
  const annotated = await annotateStuckSetup(org, repo, run);
  if (annotated?.stuckSetup) {
    void unstickIfNeeded(org, repo, annotated);
  }
  return annotated;
}

export async function sweepStuckSetupRuns(): Promise<void> {
  const msps = await listMsps();
  for (const msp of msps) {
    if (!msp.isActive) continue;
    const tenants = await listTenants(msp.id);
    await Promise.allSettled(tenants.filter(t => t.isActive).map(async (tenant) => {
      const org = tenant.giteaOrg || msp.giteaOrg;
      const repo = `tenant-${tenant.slug}`;
      await Promise.allSettled(WORKFLOWS.map(async (workflow) => {
        const runs = await getWorkflowRuns(org, repo, { workflowId: workflow, limit: 1 }).catch(() => []);
        const run = runs[0] ?? null;
        if (!run || run.status !== 'running') return;
        await annotateAndUnstick(org, repo, run);
      }));
    }));
  }
}

/** Starts once per portal process. Kicked from sync-status (boot) and the dashboard poll. */
export function startStuckSetupSweep(): void {
  if (sweepTimer) return;
  const delay = 2 * 60 * 1000;
  sweepTimer = setInterval(() => {
    void sweepStuckSetupRuns().catch((err) => {
      console.warn('[actions-unstick] sweep failed:', (err as Error).message);
    });
  }, delay);
  if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {
    sweepTimer.unref();
  }
}
