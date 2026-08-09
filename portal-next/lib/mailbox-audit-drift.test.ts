import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMailboxAuditDrift,
  isOrgAuditRemediationEnabled,
  type MailboxAuditRemediationConfig,
  type MailboxAuditStatusEntry,
} from './mailbox-audit-drift.ts';

const remediation: MailboxAuditRemediationConfig = {
  IncludeAllMailboxes: true,
  RecipientTypeDetails: ['UserMailbox', 'RoomMailbox'],
  AuditEnabled: true,
};

const status: MailboxAuditStatusEntry[] = [
  { Name: 'user1', RecipientTypeDetails: 'UserMailbox', AuditEnabled: true },
  { Name: 'room1', RecipientTypeDetails: 'RoomMailbox', AuditEnabled: false },
  { Name: 'disc1', RecipientTypeDetails: 'DiscoveryMailbox', AuditEnabled: false },
];

describe('isOrgAuditRemediationEnabled', () => {
  it('returns true when AuditDisabled is false', () => {
    assert.equal(isOrgAuditRemediationEnabled({ AuditDisabled: false }), true);
  });

  it('returns false when AuditDisabled is true or missing', () => {
    assert.equal(isOrgAuditRemediationEnabled({ AuditDisabled: true }), false);
    assert.equal(isOrgAuditRemediationEnabled({}), false);
    assert.equal(isOrgAuditRemediationEnabled(null), false);
  });
});

describe('computeMailboxAuditDrift', () => {
  it('skips when org audit remediation is disabled', () => {
    const r = computeMailboxAuditDrift(remediation, status, false);
    assert.equal(r.skipped, true);
    assert.equal(r.hasDrift, false);
    assert.equal(r.nonCompliant.length, 0);
  });

  it('IncludeAllMailboxes flags any mailbox with wrong AuditEnabled', () => {
    const r = computeMailboxAuditDrift(remediation, status, true);
    assert.equal(r.skipped, false);
    assert.equal(r.hasDrift, true);
    assert.deepEqual(r.nonCompliant.map(m => m.Name), ['room1', 'disc1']);
  });

  it('RecipientTypeDetails filter limits scope when IncludeAllMailboxes is false', () => {
    const scoped: MailboxAuditRemediationConfig = {
      IncludeAllMailboxes: false,
      RecipientTypeDetails: ['RoomMailbox', 'DiscoveryMailbox'],
      AuditEnabled: true,
    };
    const r = computeMailboxAuditDrift(scoped, status, true);
    assert.equal(r.hasDrift, true);
    assert.deepEqual(r.nonCompliant.map(m => m.Name), ['room1', 'disc1']);
  });

  it('returns no drift when all in-scope mailboxes match target', () => {
    const compliant: MailboxAuditStatusEntry[] = [
      { Name: 'user1', RecipientTypeDetails: 'UserMailbox', AuditEnabled: true },
      { Name: 'room1', RecipientTypeDetails: 'RoomMailbox', AuditEnabled: true },
    ];
    const r = computeMailboxAuditDrift(remediation, compliant, true);
    assert.equal(r.hasDrift, false);
    assert.equal(r.nonCompliant.length, 0);
  });

  it('skips when remediation has no scope configured', () => {
    const r = computeMailboxAuditDrift(
      { AuditEnabled: true },
      status,
      true,
    );
    assert.equal(r.skipped, true);
    assert.equal(r.hasDrift, false);
  });
});
