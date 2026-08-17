import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STUCK_SETUP_AFTER_MS,
  canDispatchWorkflow,
  extractDispatchInputs,
  isSetupStepName,
  isStuckInSetupJob,
} from './actions-stuck-setup.ts';

const NOW = Date.parse('2026-08-16T21:00:00.000Z');
const OLD = new Date(NOW - STUCK_SETUP_AFTER_MS - 1_000).toISOString();
const FRESH = new Date(NOW - 30_000).toISOString();

describe('isSetupStepName', () => {
  it('matches Gitea / Actions setup step labels', () => {
    assert.equal(isSetupStepName('Set up job'), true);
    assert.equal(isSetupStepName('Set up runner'), true);
    assert.equal(isSetupStepName('Setup job'), true);
    assert.equal(isSetupStepName('Checkout'), false);
    assert.equal(isSetupStepName('Run backup'), false);
  });
});

describe('isStuckInSetupJob', () => {
  it('is false when the run is not running', () => {
    assert.equal(isStuckInSetupJob(
      { status: 'waiting', created_at: OLD },
      [{ started_at: OLD, status: 'queued', steps: [] }],
      NOW,
    ), false);
  });

  it('is false when no job has been claimed', () => {
    assert.equal(isStuckInSetupJob(
      { status: 'running', created_at: OLD },
      [{ started_at: null, status: 'queued', steps: [] }],
      NOW,
    ), false);
  });

  it('detects a claimed job with empty steps older than the threshold', () => {
    assert.equal(isStuckInSetupJob(
      { status: 'running', created_at: OLD },
      [{ started_at: OLD, status: 'in_progress', steps: [] }],
      NOW,
    ), true);
  });

  it('detects a job that only has Set up job in progress', () => {
    assert.equal(isStuckInSetupJob(
      { status: 'running', created_at: OLD },
      [{
        started_at: OLD,
        status: 'in_progress',
        steps: [{ name: 'Set up job', status: 'in_progress', conclusion: null }],
      }],
      NOW,
    ), true);
  });

  it('is false while still inside the grace window', () => {
    assert.equal(isStuckInSetupJob(
      { status: 'running', created_at: FRESH },
      [{ started_at: FRESH, status: 'in_progress', steps: [] }],
      NOW,
    ), false);
  });

  it('is false when a real user step has started', () => {
    assert.equal(isStuckInSetupJob(
      { status: 'running', created_at: OLD },
      [{
        started_at: OLD,
        status: 'in_progress',
        steps: [
          { name: 'Set up job', status: 'completed', conclusion: 'success' },
          { name: 'Checkout', status: 'in_progress', conclusion: null },
        ],
      }],
      NOW,
    ), false);
  });

  it('is false when a real step already completed', () => {
    assert.equal(isStuckInSetupJob(
      { status: 'running', created_at: OLD },
      [{
        started_at: OLD,
        status: 'in_progress',
        steps: [
          { name: 'Set up job', status: 'completed', conclusion: 'success' },
          { name: 'Export M365', status: 'completed', conclusion: 'success' },
        ],
      }],
      NOW,
    ), false);
  });

  it('detects apply stuck in setup after plan already finished', () => {
    assert.equal(isStuckInSetupJob(
      { status: 'running', created_at: OLD },
      [
        {
          started_at: OLD,
          status: 'completed',
          steps: [{ name: 'WhatIf', status: 'completed', conclusion: 'success' }],
        },
        {
          started_at: OLD,
          status: 'in_progress',
          steps: [{ name: 'Set up job', status: 'in_progress', conclusion: null }],
        },
      ],
      NOW,
    ), true);
  });
});

describe('extractDispatchInputs', () => {
  it('reads top-level inputs', () => {
    assert.deepEqual(
      extractDispatchInputs({ inputs: { deploy_options: 'allowUpdate', debug_mode: false } }),
      { deploy_options: 'allowUpdate', debug_mode: 'false' },
    );
  });

  it('reads event_payload JSON inputs', () => {
    assert.deepEqual(
      extractDispatchInputs({ event_payload: JSON.stringify({ inputs: { debug_mode: 'true' } }) }),
      { debug_mode: 'true' },
    );
  });

  it('returns empty when nothing is present', () => {
    assert.deepEqual(extractDispatchInputs({ event: 'schedule' }), {});
  });
});

describe('canDispatchWorkflow', () => {
  it('allows backup and maintenance without inputs', () => {
    assert.equal(canDispatchWorkflow('backup.yml', {}), true);
    assert.equal(canDispatchWorkflow('.gitea/workflows/maintenance.yml', {}), true);
  });

  it('blocks deploy without deploy_options', () => {
    assert.equal(canDispatchWorkflow('deploy.yml', {}), false);
    assert.equal(canDispatchWorkflow('deploy.yml', { deploy_options: 'allowUpdate' }), true);
  });
});
