import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRuleCollectionXml,
  serializeRuleCollectionXml,
  mergeOverlay,
  overlayFromTenantBackup,
  flattenTenantOverlayRows,
  defaultRules,
  collectionFromOmaUri,
  collectionFromFileName,
  applyCollectionToDeviceConfig,
  extractOmaSetting,
  parseOverlayJson,
  applyOverlayToDeviceConfigJson,
  canonicalizeAppLockerXml,
  diffAppLockerXml,
  SID_EVERYONE,
  SID_ADMINISTRATORS,
  type AppLockerRule,
  type RuleCollection,
} from './applocker.ts';

const SAMPLE = `<RuleCollection Type="Exe" EnforcementMode="AuditOnly">
  <FilePublisherRule Id="11111111-1111-1111-1111-111111111111" Name="Allow Teams" Description="signed" UserOrGroupSid="S-1-1-0" Action="Allow">
    <Conditions>
      <FilePublisherCondition PublisherName="O=MICROSOFT CORPORATION, L=REDMOND, S=WASHINGTON, C=US" ProductName="MICROSOFT TEAMS" BinaryName="TEAMS.EXE">
        <BinaryVersionRange LowSection="*" HighSection="*" />
      </FilePublisherCondition>
    </Conditions>
    <Exceptions>
      <FilePathCondition Path="%OSDRIVE%\\Temp\\*" />
    </Exceptions>
  </FilePublisherRule>
  <FilePathRule Id="22222222-2222-2222-2222-222222222222" Name="Windows" UserOrGroupSid="S-1-1-0" Action="Allow">
    <Conditions>
      <FilePathCondition Path="%WINDIR%\\*" />
    </Conditions>
  </FilePathRule>
  <FileHashRule Id="33333333-3333-3333-3333-333333333333" Name="Hash allow" UserOrGroupSid="S-1-5-32-544" Action="Deny">
    <Conditions>
      <FileHashCondition>
        <FileHash Type="SHA256" Data="AABBCC" SourceFileName="foo.exe" SourceFileLength="12" />
      </FileHashCondition>
    </Conditions>
  </FileHashRule>
</RuleCollection>`;

describe('collection detection', () => {
  it('maps OMA-URIs', () => {
    assert.equal(collectionFromOmaUri('./Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/EXE/Policy'), 'Exe');
    assert.equal(collectionFromOmaUri('./Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/StoreApps/Policy'), 'Appx');
    assert.equal(collectionFromOmaUri('./Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/Script/Policy'), 'Script');
  });

  it('maps file names', () => {
    assert.equal(collectionFromFileName('Baseline - Applocker exe.json'), 'Exe');
    assert.equal(collectionFromFileName('Baseline - Applocker script.assignment.json'), 'Script');
    assert.equal(collectionFromFileName('Some other policy.json'), null);
  });
});

describe('parse / serialize', () => {
  it('round-trips publisher, path, hash, and exceptions', () => {
    const parsed = parseRuleCollectionXml(SAMPLE);
    assert.equal(parsed.type, 'Exe');
    assert.equal(parsed.enforcementMode, 'AuditOnly');
    assert.equal(parsed.rules.length, 3);

    const pub = parsed.rules.find(r => r.xmlName === 'FilePublisherRule')!;
    assert.equal(pub.name, 'Allow Teams');
    assert.equal(pub.conditions[0].kind, 'publisher');
    if (pub.conditions[0].kind === 'publisher') {
      assert.equal(pub.conditions[0].productName, 'MICROSOFT TEAMS');
      assert.equal(pub.conditions[0].binaryName, 'TEAMS.EXE');
    }
    assert.equal(pub.exceptions[0].kind, 'path');
    if (pub.exceptions[0].kind === 'path') assert.equal(pub.exceptions[0].path, '%OSDRIVE%\\Temp\\*');

    const hash = parsed.rules.find(r => r.xmlName === 'FileHashRule')!;
    assert.equal(hash.action, 'Deny');
    assert.equal(hash.userOrGroupSid, SID_ADMINISTRATORS);
    if (hash.conditions[0].kind === 'hash') {
      assert.equal(hash.conditions[0].hashes[0].data, 'AABBCC');
      assert.equal(hash.conditions[0].hashes[0].sourceFileName, 'foo.exe');
    }

    const xml = serializeRuleCollectionXml(parsed);
    const again = parseRuleCollectionXml(xml);
    assert.deepEqual(again, parsed);
  });

  it('parses AppLockerPolicy export and picks the requested collection', () => {
    const exported = `<AppLockerPolicy Version="1">${SAMPLE}<RuleCollection Type="Script" EnforcementMode="Enabled"></RuleCollection></AppLockerPolicy>`;
    const script = parseRuleCollectionXml(exported, 'Script');
    assert.equal(script.type, 'Script');
    assert.equal(script.enforcementMode, 'Enabled');
    assert.equal(script.rules.length, 0);
  });
});

describe('overlay merge', () => {
  it('drops excluded baseline rules and appends additions', () => {
    const baseline = parseRuleCollectionXml(SAMPLE);
    const extra: AppLockerRule = {
      id: '44444444-4444-4444-4444-444444444444',
      xmlName: 'FilePathRule',
      name: 'Tenant tool',
      description: '',
      userOrGroupSid: SID_EVERYONE,
      action: 'Allow',
      conditions: [{ kind: 'path', path: 'C:\\Tools\\*' }],
      exceptions: [],
    };
    const merged = mergeOverlay(baseline, {
      excludeRuleIds: ['22222222-2222-2222-2222-222222222222'],
      rules: [extra],
    });
    assert.equal(merged.rules.some(r => r.id.startsWith('2222')), false);
    assert.equal(merged.rules.some(r => r.id.startsWith('1111')), true);
    assert.equal(merged.rules.some(r => r.name === 'Tenant tool'), true);
    assert.equal(merged.enforcementMode, 'AuditOnly');
  });

  it('same-id overlay rule replaces the baseline rule instead of duplicating it', () => {
    const baseline = parseRuleCollectionXml(SAMPLE);
    const existing = baseline.rules[0];
    const merged = mergeOverlay(baseline, {
      excludeRuleIds: [],
      rules: [{ ...existing, name: `${existing.name} (again)` }],
    });
    const matches = merged.rules.filter(r => r.id.toLowerCase() === existing.id.toLowerCase());
    assert.equal(matches.length, 1);
    assert.equal(matches[0].name, `${existing.name} (again)`);
  });

  it('overlay enforcement overrides baseline', () => {
    const baseline: RuleCollection = { type: 'Exe', enforcementMode: 'AuditOnly', rules: [] };
    const merged = mergeOverlay(baseline, { excludeRuleIds: [], rules: [], enforcementMode: 'Enabled' });
    assert.equal(merged.enforcementMode, 'Enabled');
  });

  it('overlayFromTenantBackup excludes missing baseline rules and imports extras', () => {
    const baseline = parseRuleCollectionXml(SAMPLE);
    const tenantXml = `<RuleCollection Type="Exe" EnforcementMode="Enabled">
  <FilePublisherRule Id="11111111-1111-1111-1111-111111111111" Name="Allow Teams" Description="signed" UserOrGroupSid="S-1-1-0" Action="Allow">
    <Conditions>
      <FilePublisherCondition PublisherName="O=MICROSOFT CORPORATION, L=REDMOND, S=WASHINGTON, C=US" ProductName="MICROSOFT TEAMS" BinaryName="TEAMS.EXE">
        <BinaryVersionRange LowSection="*" HighSection="*" />
      </FilePublisherCondition>
    </Conditions>
    <Exceptions>
      <FilePathCondition Path="%OSDRIVE%\\Temp\\*" />
    </Exceptions>
  </FilePublisherRule>
  <FilePathRule Id="55555555-5555-5555-5555-555555555555" Name="Tenant path" UserOrGroupSid="S-1-1-0" Action="Allow">
    <Conditions>
      <FilePathCondition Path="C:\\Tenant\\*" />
    </Conditions>
  </FilePathRule>
</RuleCollection>`;
    const tenant = parseRuleCollectionXml(tenantXml);
    const overlay = overlayFromTenantBackup(baseline, tenant);
    assert.ok(overlay.excludeRuleIds.includes('22222222-2222-2222-2222-222222222222'));
    assert.ok(overlay.excludeRuleIds.includes('33333333-3333-3333-3333-333333333333'));
    assert.equal(overlay.rules.some(r => r.id.startsWith('5555')), true);
    assert.equal(overlay.rules.some(r => r.id.startsWith('1111')), false);
    assert.equal(overlay.enforcementMode, 'Enabled');
  });

  it('overlayFromTenantBackup treats same-id content changes as tenant overrides', () => {
    const baseline = parseRuleCollectionXml(SAMPLE);
    const tenantXml = SAMPLE.replace('Name="Windows"', 'Name="Windows (tenant)"');
    const overlay = overlayFromTenantBackup(baseline, parseRuleCollectionXml(tenantXml));
    assert.ok(overlay.excludeRuleIds.includes('22222222-2222-2222-2222-222222222222'));
    assert.equal(overlay.rules.find(r => r.id.startsWith('2222'))?.name, 'Windows (tenant)');
    assert.equal(overlay.enforcementMode, undefined);
  });

  it('parseOverlayJson accepts structured rules', () => {
    const overlay = parseOverlayJson({
      excludeRuleIds: ['abc'],
      rules: [{
        xmlName: 'FilePathRule',
        name: 'x',
        userOrGroupSid: SID_EVERYONE,
        action: 'Allow',
        conditions: [{ kind: 'path', path: 'C:\\x\\*' }],
      }],
    });
    assert.deepEqual(overlay.excludeRuleIds, ['abc']);
    assert.equal(overlay.rules[0].xmlName, 'FilePathRule');
    assert.equal(overlay.rules[0].conditions[0].kind, 'path');
  });

  it('applyOverlayToDeviceConfigJson merges tenant rules into baseline XML', () => {
    const baselineJson = JSON.stringify({
      displayName: 'Baseline - Applocker script',
      omaSettings: [{
        displayName: 'applockerscript',
        omaUri: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/Script/Policy',
        value: SAMPLE.replace('Type="Exe"', 'Type="Script"'),
      }],
    });
    const extra: AppLockerRule = {
      id: 'ec689ddb-ec66-4e59-85a6-fc2955323567',
      xmlName: 'FilePathRule',
      name: '%OSDRIVE%\\USERS\\*\\APPDATA\\LOCAL\\GOOGLE\\*',
      description: '',
      userOrGroupSid: 'S-1-5-18',
      action: 'Allow',
      conditions: [{ kind: 'path', path: '%OSDRIVE%\\USERS\\*\\APPDATA\\LOCAL\\GOOGLE\\*' }],
      exceptions: [],
    };
    const merged = applyOverlayToDeviceConfigJson(
      baselineJson,
      { excludeRuleIds: [], rules: [extra] },
      'intune/device-configurations/Baseline - Applocker script.json',
    );
    const oma = extractOmaSetting(JSON.parse(merged) as Record<string, unknown>);
    assert.ok(oma?.value.includes('GOOGLE'));
    assert.ok(oma?.value.includes('ec689ddb-ec66-4e59-85a6-fc2955323567'));
  });

  it('canonicalizeAppLockerXml ignores pretty-print whitespace', () => {
    const compact = canonicalizeAppLockerXml(SAMPLE.replace(/\s+/g, ' ').replace(/> </g, '><'));
    const pretty = canonicalizeAppLockerXml(SAMPLE);
    assert.equal(compact, pretty);
  });

  it('applyOverlayToDeviceConfigJson matches tenant XML when overlay only reorders a rule', () => {
    const extra: AppLockerRule = {
      id: '847f8fac-9888-46fa-89a7-7edcbce4d5ca',
      xmlName: 'FilePathRule',
      name: '%OSDRIVE%\\USERS\\*\\DOWNLOADS\\*\\RUN\\*',
      description: '',
      userOrGroupSid: SID_EVERYONE,
      action: 'Allow',
      conditions: [{ kind: 'path', path: '%OSDRIVE%\\USERS\\*\\DOWNLOADS\\*\\RUN\\*' }],
      exceptions: [],
    };
    const sample = parseRuleCollectionXml(SAMPLE.replace('Type="Exe"', 'Type="Script"'));
    const file = (rules: AppLockerRule[]) => JSON.stringify({
      displayName: 'Baseline - Applocker script',
      omaSettings: [{
        displayName: 'applockerscript',
        omaUri: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/Script/Policy',
        value: serializeRuleCollectionXml({ type: 'Script', enforcementMode: 'Enabled', rules }),
      }],
    });
    const desired = applyOverlayToDeviceConfigJson(
      file(sample.rules),
      { excludeRuleIds: [], rules: [extra] },
      'Baseline - Applocker script.json',
    );
    const current = applyOverlayToDeviceConfigJson(
      file([sample.rules[0], extra, ...sample.rules.slice(1)]),
      null,
      'Baseline - Applocker script.json',
    );
    const desiredOma = extractOmaSetting(JSON.parse(desired) as Record<string, unknown>)?.value;
    const currentOma = extractOmaSetting(JSON.parse(current) as Record<string, unknown>)?.value;
    assert.equal(desiredOma, currentOma);
    assert.ok(desiredOma?.includes('847f8fac-9888-46fa-89a7-7edcbce4d5ca'));
  });
});

describe('flattenTenantOverlayRows', () => {
  const pathRule = (id: string, name: string): AppLockerRule => ({
    id,
    xmlName: 'FilePathRule',
    name,
    description: '',
    userOrGroupSid: SID_EVERYONE,
    action: 'Allow',
    conditions: [{ kind: 'path', path: 'C:\\Tools\\*' }],
    exceptions: [],
  });

  it('tenant-only rule appears once with that tenant slug', () => {
    const extra = pathRule('44444444-4444-4444-4444-444444444444', 'Tenant tool');
    const { rows, excludedBy } = flattenTenantOverlayRows(
      parseRuleCollectionXml(SAMPLE).rules,
      [{ slug: 'acme', displayName: 'Acme Corp', excludeRuleIds: [], rules: [extra] }],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slug, 'acme');
    assert.equal(rows[0].displayName, 'Acme Corp');
    assert.equal(rows[0].customized, false);
    assert.equal(rows[0].key, 'acme:44444444-4444-4444-4444-444444444444');
    assert.deepEqual(excludedBy, {});
  });

  it('modified baseline rule is marked customized', () => {
    const baseline = parseRuleCollectionXml(SAMPLE).rules;
    const edited = { ...baseline[0], name: 'Allow Teams (tenant)' };
    const { rows } = flattenTenantOverlayRows(baseline, [{
      slug: 'acme',
      displayName: 'Acme Corp',
      excludeRuleIds: [baseline[0].id],
      rules: [edited],
    }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customized, true);
    assert.equal(rows[0].rule.name, 'Allow Teams (tenant)');
  });

  it('excluded baseline IDs produce excludedBy names', () => {
    const baseline = parseRuleCollectionXml(SAMPLE).rules;
    const { excludedBy } = flattenTenantOverlayRows(baseline, [{
      slug: 'acme',
      displayName: 'Acme Corp',
      excludeRuleIds: ['22222222-2222-2222-2222-222222222222'],
      rules: [],
    }, {
      slug: 'beta',
      displayName: 'Beta LLC',
      excludeRuleIds: ['22222222-2222-2222-2222-222222222222'],
      rules: [],
    }]);
    assert.deepEqual(excludedBy['22222222-2222-2222-2222-222222222222'], ['Acme Corp', 'Beta LLC']);
  });

  it('two tenants with the same rule id produce two rows', () => {
    const extra = pathRule('44444444-4444-4444-4444-444444444444', 'Tenant tool');
    const { rows } = flattenTenantOverlayRows([], [
      { slug: 'acme', displayName: 'Acme Corp', excludeRuleIds: [], rules: [extra] },
      { slug: 'beta', displayName: 'Beta LLC', excludeRuleIds: [], rules: [extra] },
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.key), [
      'acme:44444444-4444-4444-4444-444444444444',
      'beta:44444444-4444-4444-4444-444444444444',
    ]);
  });
});

describe('default rules', () => {
  it('creates MMC defaults for each collection', () => {
    assert.equal(defaultRules('Exe').length, 3);
    assert.equal(defaultRules('Msi').length, 3);
    assert.equal(defaultRules('Script').length, 3);
    assert.equal(defaultRules('Appx').length, 1);
    const xml = serializeRuleCollectionXml({ type: 'Exe', enforcementMode: 'Enabled', rules: defaultRules('Exe') });
    const parsed = parseRuleCollectionXml(xml);
    assert.equal(parsed.rules.length, 3);
    assert.ok(parsed.rules.some(r => r.userOrGroupSid === SID_ADMINISTRATORS));
  });
});

describe('extractOmaSetting', () => {
  it('reads a PowerShell-collapsed single omaSettings object from tenant backup', () => {
    const oma = extractOmaSetting({
      displayName: 'Baseline - Applocker exe',
      omaSettings: {
        displayName: 'applockerexe',
        omaUri: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/EXE/Policy',
        value: SAMPLE,
        isEncrypted: false,
      },
    });
    assert.ok(oma);
    assert.equal(oma?.omaUri.includes('/EXE/Policy'), true);
    assert.match(oma?.value ?? '', /RuleCollection/);
  });
});

describe('device config apply', () => {
  it('writes RuleCollection back into omaSettings.value', () => {
    const json = {
      '@odata.type': '#microsoft.graph.windows10CustomConfiguration',
      displayName: 'Baseline - Applocker exe',
      omaSettings: [{
        '@odata.type': '#microsoft.graph.omaSettingString',
        displayName: 'applockerexe',
        omaUri: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/EXE/Policy',
        value: SAMPLE,
      }],
    };
    const col = parseRuleCollectionXml(SAMPLE);
    col.enforcementMode = 'Enabled';
    const next = applyCollectionToDeviceConfig(json, col);
    const oma = extractOmaSetting(next as Record<string, unknown>);
    assert.ok(oma);
    assert.match(oma!.value, /EnforcementMode="Enabled"/);
    assert.equal(collectionFromOmaUri(oma!.omaUri), 'Exe');
  });

  it('rewrites a PowerShell-collapsed single omaSettings object', () => {
    const json = {
      displayName: 'Baseline - Applocker script',
      omaSettings: {
        displayName: 'applockerscript',
        omaUri: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/Script/Policy',
        value: SAMPLE.replace('Type="Exe"', 'Type="Script"'),
      },
    };
    const col = parseRuleCollectionXml(SAMPLE, 'Script');
    const next = applyCollectionToDeviceConfig(json, col);
    const oma = extractOmaSetting(next as Record<string, unknown>);
    assert.ok(oma?.value);
    assert.equal(Array.isArray(next.omaSettings), true);
  });
});

describe('diffAppLockerXml', () => {
  it('reports only the added rule and pretty-prints XML', () => {
    const base = `<RuleCollection Type="Script" EnforcementMode="Enabled">
      <FilePathRule Id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" Name="First" UserOrGroupSid="S-1-1-0" Action="Allow">
        <Conditions><FilePathCondition Path="A\\*" /></Conditions>
      </FilePathRule>
    </RuleCollection>`;
    const extra = base.replace(
      '</RuleCollection>',
      `<FilePathRule Id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" Name="Second" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePathCondition Path="B\\*" /></Conditions></FilePathRule></RuleCollection>`,
    );
    const diffs = diffAppLockerXml(base, extra);
    assert.ok(diffs);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].type, 'add');
    assert.match(diffs[0].label, /Second/);
    assert.match(diffs[0].desired ?? '', /<FilePathRule/);
    assert.match(diffs[0].desired ?? '', /\n/);
  });
});
