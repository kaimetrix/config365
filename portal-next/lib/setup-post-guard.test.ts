import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSetupPostAllowed } from './setup-post-guard.ts';

describe('assertSetupPostAllowed', () => {
  it('rejects all POSTs after setup is complete', () => {
    assert.deepEqual(assertSetupPostAllowed(true, 'azure', false), {
      status: 403,
      error: 'Setup is already complete',
    });
    assert.deepEqual(assertSetupPostAllowed(true, 'complete', true), {
      status: 403,
      error: 'Setup is already complete',
    });
  });

  it('allows unauthenticated azure while setup is incomplete', () => {
    assert.equal(assertSetupPostAllowed(false, 'azure', false), null);
    assert.equal(assertSetupPostAllowed(false, 'azure', true), null);
  });

  it('rejects non-azure steps without a session', () => {
    assert.deepEqual(assertSetupPostAllowed(false, 'database-save', false), {
      status: 401,
      error: 'Unauthenticated',
    });
    assert.deepEqual(assertSetupPostAllowed(false, 'complete', false), {
      status: 401,
      error: 'Unauthenticated',
    });
  });

  it('allows non-azure steps with a session while incomplete', () => {
    assert.equal(assertSetupPostAllowed(false, 'database-save', true), null);
    assert.equal(assertSetupPostAllowed(false, 'complete', true), null);
  });
});
