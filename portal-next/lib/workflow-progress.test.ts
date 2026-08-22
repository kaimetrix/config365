import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRunProgress, type WorkflowJob } from './workflow-progress.ts';

function job(name: string, status: string, steps: WorkflowJob['steps'] = []): WorkflowJob {
  return { name, status, steps };
}

function step(name: string, status: string): NonNullable<WorkflowJob['steps']>[number] {
  return { name, status };
}

describe('summarizeRunProgress', () => {
  it('returns null for no jobs', () => {
    assert.equal(summarizeRunProgress([]), null);
  });

  it('counts every step on the running job, including setup', () => {
    const jobs: WorkflowJob[] = [
      job('Generate Deployment Plan (WhatIf)', 'completed', [
        step('Checkout Tenant Repository', 'completed'),
        step('Plan - Groups', 'completed'),
        step('Plan - Intune', 'completed'),
      ]),
      job('Export M365 Configurations', 'in_progress', [
        step('Initialize Job Session Isolation', 'completed'),
        step('Checkout Tenant Repository', 'completed'),
        step('Checkout Orchestrator', 'completed'),
        step('Sync pipeline from orchestrator', 'completed'),
        step('Prepare - Assign Required Directory Roles', 'completed'),
        step('Initialize Backup Directory', 'completed'),
        step('Backup - Groups', 'completed'),
        step('Backup - Group Membership', 'in_progress'),
        step('Backup - Licenses', 'queued'),
      ]),
    ];
    assert.deepEqual(summarizeRunProgress(jobs), {
      completed: 7,
      total: 9,
      current: 'Backup - Group Membership',
    });
  });

  it('falls back to all steps when no module stages exist', () => {
    const jobs: WorkflowJob[] = [
      job('Await Deployment Approval', 'in_progress', [
        step('Create approval issue', 'completed'),
        step('Poll for approval', 'in_progress'),
      ]),
    ];
    assert.deepEqual(summarizeRunProgress(jobs), {
      completed: 1,
      total: 2,
      current: 'Poll for approval',
    });
  });

  it('falls back to job-level counts when the current job has no steps', () => {
    const jobs: WorkflowJob[] = [
      job('Generate Deployment Plan (WhatIf)', 'completed'),
      job('Await Deployment Approval', 'waiting'),
      job('Apply M365 Configuration Changes', 'queued'),
      job('Post-Deployment Validation', 'queued'),
    ];
    assert.deepEqual(summarizeRunProgress(jobs), {
      completed: 1,
      total: 4,
      current: 'Await Deployment Approval',
    });
  });
});
