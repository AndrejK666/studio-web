import { describe, expect, it } from 'vitest';

import type { SpecModelIssueRow } from '../api/types';
import type { DocQualityItem } from './doc-quality';
import { issueBody, issueRows, queueKindId } from './issue-rows';

const row = (extra: Partial<SpecModelIssueRow> = {}): SpecModelIssueRow => ({
  key: 'f:fp',
  kind: 'finding',
  label: 'Problem',
  group: 'blocks',
  tone: 'bad',
  concern: false,
  title: 'ADR-0040 is cited, but there is no ADR numbered 40',
  hint: 'A document points at something that does not exist.',
  sides: [{ path: 'docs/a.md', line_start: 4, quote: 'See ADR-0040.' }],
  fingerprint: 'fp',
  rule: 'reference.dangling',
  decision: null,
  edit: null,
  decide: [],
  requirement_id: null,
  issue_url: null,
  actions: ['confirm', 'dismiss', 'create_issue'],
  done: false,
  ...extra,
});

const doc: DocQualityItem = {
  key: 'def:invoice',
  type: 'nodefinition',
  title: 'Invoice has no definition',
  hint: 'Say what it is.',
  sides: [{ path: 'docs/b.md', line_start: 2 }],
};

describe('the Issues table', () => {
  it("puts the server's queue first, in its order, then the documentation's thin places", () => {
    const rows = issueRows([row(), row({ key: 'q:FR-1', kind: 'question', label: 'Open question', fingerprint: null })], [doc]);
    expect(rows.map((r) => [r.key, r.group, r.kindId])).toEqual([
      ['f:fp', 'blocks', 'problem'],
      ['q:FR-1', 'blocks', 'question'],
      ['def:invoice', 'improve', 'nodefinition'],
    ]);
    expect(rows[2].label).toBe('No definition');
    expect(rows[0].side?.path).toBe('docs/a.md');
  });

  it('names a judged contradiction a possible conflict', () => {
    expect(queueKindId({ kind: 'finding', concern: true })).toBe('conflict');
    expect(queueKindId({ kind: 'nobasis', concern: false })).toBe('nobasis');
  });

  it("writes an issue's text: what, where, and the fix the documents show", () => {
    const [r] = issueRows([row({ edit: { path: 'docs/a.md', replace: 'ADR-0040', with: 'ADR-0041' } })], []);
    const body = issueBody(r);
    expect(body).toContain('**Problem** — stops a build.');
    expect(body).toContain('- `docs/a.md:4` — “See ADR-0040.”');
    expect(body).toContain('```diff\n- ADR-0040\n+ ADR-0041\n```');
    expect(body.endsWith("_Opened from the project's Issues in Constructor Studio._")).toBe(true);
  });
});
