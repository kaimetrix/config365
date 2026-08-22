import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeXml,
  parseXmlEntries,
  xmlToDiffObject,
  expandXmlInJson,
  diffXmlEntries,
  interpretOmaXmlLines,
  meaningfulOmaLines,
} from './xml-entries.ts';

const XML = `<RuleCollection Type="Script" EnforcementMode="Enabled">
  <FilePathRule Id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" Name="Second" UserOrGroupSid="S-1-1-0" Action="Allow">
    <Conditions><FilePathCondition Path="B\\*" /></Conditions>
  </FilePathRule>
  <FilePathRule Id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" Name="First" UserOrGroupSid="S-1-1-0" Action="Allow">
    <Conditions><FilePathCondition Path="A\\*" /></Conditions>
  </FilePathRule>
</RuleCollection>`;

describe('xml entries', () => {
  it('detects XML strings', () => {
    assert.equal(looksLikeXml(XML), true);
    assert.equal(looksLikeXml('{ "a": 1 }'), false);
    assert.equal(looksLikeXml(''), false);
  });

  it('splits RuleCollection children and sorts by Id', () => {
    const parsed = parseXmlEntries(XML);
    assert.ok(parsed);
    assert.equal(parsed.root, 'RuleCollection');
    assert.equal(parsed.attrs.Type, 'Script');
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0].key, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.equal(parsed.entries[1].key, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  it('same rules in a different order produce the same diff object', () => {
    const aFirst = `<RuleCollection Type="Script" EnforcementMode="Enabled">
  <FilePathRule Id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" Name="First" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePathCondition Path="A\\*" /></Conditions></FilePathRule>
  <FilePathRule Id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" Name="Second" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePathCondition Path="B\\*" /></Conditions></FilePathRule>
</RuleCollection>`;
    assert.deepEqual(xmlToDiffObject(XML), xmlToDiffObject(aFirst));
  });

  it('diffXmlEntries reports only the added rule', () => {
    const extra = XML.replace(
      '</RuleCollection>',
      `<FilePathRule Id="cccccccc-cccc-cccc-cccc-cccccccccccc" Name="Extra" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePathCondition Path="C\\*" /></Conditions></FilePathRule></RuleCollection>`,
    );
    const diffs = diffXmlEntries(XML, extra);
    assert.ok(diffs);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].type, 'add');
    assert.equal(diffs[0].key, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  it('expandXmlInJson rewrites omaSettings.value into entries', () => {
    const expanded = expandXmlInJson({
      displayName: 'Baseline - Applocker script',
      omaSettings: [{ displayName: 'applockerscript', value: XML }],
    }) as { omaSettings: Array<{ value: { _xml: string; entries: string[] } }> };
    assert.equal(expanded.omaSettings[0].value._xml, 'RuleCollection');
    assert.equal(expanded.omaSettings[0].value.entries.length, 2);
  });

  it('treats truncated runner FROM/TO OMA lines as truncated (not a fake 3-line diff)', () => {
    const lines = [
      '~ applockerscript value:',
      '    FROM: <RuleCollection Type="Script" EnforcementMode="Enabled"> <FilePublisherRu...',
      '    TO:   <RuleCollection Type="Script" EnforcementMode="Enabled"><FilePublisherRule Id...',
    ];
    assert.equal(interpretOmaXmlLines(lines).kind, 'truncated');
    assert.deepEqual(meaningfulOmaLines(lines), []);
  });

  it('keeps OMA lines when complete XML actually differs', () => {
    const extra = XML.replace(
      '</RuleCollection>',
      `<FilePathRule Id="cccccccc-cccc-cccc-cccc-cccccccccccc" Name="Extra" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePathCondition Path="C\\*" /></Conditions></FilePathRule></RuleCollection>`,
    );
    const lines = [`FROM: ${XML}`, `TO: ${extra}`];
    assert.equal(interpretOmaXmlLines(lines).kind, 'unknown');
    assert.equal(meaningfulOmaLines(lines).length, 2);
  });
});
