/** Live x/x progress for a Gitea Actions run (jobs + steps). */

export interface WorkflowProgress {
  completed: number;
  total: number;
  /** Name of the step or job currently running. */
  current?: string;
}

export interface WorkflowJobStep {
  name: string;
  status: string;
  conclusion?: string | null;
}

export interface WorkflowJob {
  name: string;
  status: string;
  conclusion?: string | null;
  steps?: WorkflowJobStep[];
}

function isActive(status: string): boolean {
  return status === 'in_progress' || status === 'running' || status === 'waiting' || status === 'queued';
}

function isFinished(status: string): boolean {
  return status === 'completed' || status === 'success' || status === 'failure' || status === 'cancelled' || status === 'skipped';
}

function pickCurrentJob(jobs: WorkflowJob[]): WorkflowJob | undefined {
  return jobs.find(j => isActive(j.status))
    ?? jobs.find(j => !isFinished(j.status))
    ?? jobs[jobs.length - 1];
}

function countSteps(steps: WorkflowJobStep[]): WorkflowProgress | null {
  if (steps.length === 0) return null;
  const completed = steps.filter(s => isFinished(s.status)).length;
  const current = steps.find(s => s.status === 'in_progress' || s.status === 'running')?.name
    ?? steps.find(s => isActive(s.status))?.name;
  return { completed, total: steps.length, current };
}

/**
 * Count every step in the current job (setup + modules + wrap-up) so the
 * badge matches the Gitea Actions task list. Fall back to job-level counts
 * when the current job has not published steps yet (e.g. deploy gate).
 */
export function summarizeRunProgress(jobs: WorkflowJob[]): WorkflowProgress | null {
  if (jobs.length === 0) return null;

  const currentJob = pickCurrentJob(jobs);
  const fromSteps = countSteps(currentJob?.steps ?? []);
  if (fromSteps) {
    return { ...fromSteps, current: fromSteps.current ?? currentJob?.name };
  }

  const completed = jobs.filter(j => isFinished(j.status)).length;
  return { completed, total: jobs.length, current: currentJob?.name };
}
