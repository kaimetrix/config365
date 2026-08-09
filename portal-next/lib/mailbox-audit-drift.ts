/**
 * Derived drift for exchange/mailbox-audit-remediation.json vs tenant backup
 * exchange/mailbox-audit-status.json. Mirrors Configure-Exchange.ps1 MailboxAuditRemediation.
 */

export const REMEDIATION_PATH = 'exchange/mailbox-audit-remediation.json';
export const AUDIT_STATUS_PATH = 'exchange/mailbox-audit-status.json';
export const ORG_AUDIT_DISABLED_PATH = 'exchange/organization-config/AuditDisabled.json';

export interface MailboxAuditRemediationConfig {
  IncludeAllMailboxes?: boolean;
  RecipientTypeDetails?: string[];
  AuditEnabled?: boolean;
}

export interface MailboxAuditStatusEntry {
  Name: string;
  RecipientTypeDetails: string;
  AuditEnabled: boolean;
}

export interface MailboxAuditDriftResult {
  hasDrift: boolean;
  skipped: boolean;
  skipReason?: string;
  nonCompliant: MailboxAuditStatusEntry[];
  targetAuditEnabled: boolean;
}

/** True when baseline organization-config/AuditDisabled.json sets AuditDisabled=false. */
export function isOrgAuditRemediationEnabled(auditDisabledConfig: unknown): boolean {
  if (auditDisabledConfig === null || typeof auditDisabledConfig !== 'object') return false;
  return (auditDisabledConfig as Record<string, unknown>).AuditDisabled === false;
}

function parseAuditStatus(raw: unknown): MailboxAuditStatusEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is MailboxAuditStatusEntry =>
      e !== null &&
      typeof e === 'object' &&
      typeof (e as MailboxAuditStatusEntry).Name === 'string' &&
      typeof (e as MailboxAuditStatusEntry).RecipientTypeDetails === 'string' &&
      typeof (e as MailboxAuditStatusEntry).AuditEnabled === 'boolean',
  );
}

/**
 * Returns mailboxes in the backup snapshot that do not match remediation rules.
 */
export function computeMailboxAuditDrift(
  remediation: MailboxAuditRemediationConfig | null | undefined,
  auditStatusRaw: unknown,
  orgAuditRemediationEnabled: boolean,
): MailboxAuditDriftResult {
  const targetAudit =
    remediation?.AuditEnabled !== undefined ? Boolean(remediation.AuditEnabled) : true;

  if (!orgAuditRemediationEnabled) {
    return {
      hasDrift: false,
      skipped: true,
      skipReason: 'Organization audit remediation not enabled (AuditDisabled must be false)',
      nonCompliant: [],
      targetAuditEnabled: targetAudit,
    };
  }

  if (!remediation) {
    return {
      hasDrift: false,
      skipped: true,
      skipReason: 'No mailbox-audit-remediation baseline config',
      nonCompliant: [],
      targetAuditEnabled: targetAudit,
    };
  }

  const includeAll = remediation.IncludeAllMailboxes === true;
  const targetTypes = remediation.RecipientTypeDetails ?? [];

  if (!includeAll && targetTypes.length === 0) {
    return {
      hasDrift: false,
      skipped: true,
      skipReason: 'Remediation config has no IncludeAllMailboxes or RecipientTypeDetails',
      nonCompliant: [],
      targetAuditEnabled: targetAudit,
    };
  }

  const entries = parseAuditStatus(auditStatusRaw);
  const nonCompliant = entries.filter(mbx => {
    const audit = Boolean(mbx.AuditEnabled);
    if (includeAll) return audit !== targetAudit;
    return targetTypes.includes(mbx.RecipientTypeDetails) && audit !== targetAudit;
  });

  return {
    hasDrift: nonCompliant.length > 0,
    skipped: false,
    nonCompliant,
    targetAuditEnabled: targetAudit,
  };
}

export function parseJsonContent(raw: string): unknown {
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}
