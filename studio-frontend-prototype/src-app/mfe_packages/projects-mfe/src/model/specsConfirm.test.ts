import { describe, expect, it } from 'vitest';
import type { SpecRow } from './specRows';
import { confirmOutcome, proposedTargets, selectedTargets, typeSummary } from './specsConfirm';

const row = (id: string, overrides: Partial<SpecRow> = {}): SpecRow => ({
  id,
  origin: 'repository',
  name: `${id}.md`,
  state: 'detected',
  type: { key: 'design', name: 'Design Document', proposed: true, confidence: 0.57 },
  review: { kind: 'check_needed' },
  source: { kind: 'unknown' },
  open: null,
  location: '',
  typeEditable: true,
  checkable: true,
  failing: false,
  ...overrides,
});

const PRD = { key: 'prd', name: 'Product Requirements (PRD)', proposed: true, confidence: 0.8 };

describe('the proposed types a person may confirm', () => {
  it('are the editable rows whose type is still proposed', () => {
    const rows = [
      row('b-1'),
      row('b-2', { type: PRD }),
      row('b-3', { state: 'confirmed', type: { ...PRD, proposed: false } }),
      row('b-4', { type: null, state: 'unknown' }),
      // A Studio document's type is never decided here.
      row('d-1', { origin: 'authored', typeEditable: false }),
    ];
    expect(proposedTargets(rows)).toEqual([
      { id: 'b-1', name: 'b-1.md', typeName: 'Design Document' },
      { id: 'b-2', name: 'b-2.md', typeName: 'Product Requirements (PRD)' },
    ]);
  });

  it('of a selection are the selected ones with a proposal; the rest are counted as skipped', () => {
    const proposed = proposedTargets([row('b-1'), row('b-2')]);
    expect(selectedTargets(['b-2', 'b-9', 'd-1'], proposed)).toEqual({
      targets: [{ id: 'b-2', name: 'b-2.md', typeName: 'Design Document' }],
      skipped: 2,
    });
    expect(selectedTargets([], proposed)).toEqual({ targets: [], skipped: 0 });
  });

  it('are summed up by type, most first', () => {
    const targets = proposedTargets([row('b-1', { type: PRD }), row('b-2'), row('b-3')]);
    expect(typeSummary(targets)).toEqual([
      { typeName: 'Design Document', count: 2 },
      { typeName: 'Product Requirements (PRD)', count: 1 },
    ]);
  });
});

describe("the server's answer", () => {
  it('counts what was confirmed and names what was skipped', () => {
    const targets = proposedTargets([row('b-1'), row('b-2')]);
    expect(
      confirmOutcome(targets, {
        confirmed: [{ id: 'b-1', type_key: 'design', state: 'confirmed' }],
        skipped: [
          { id: 'b-2', reason: 'not_proposed' },
          { id: 'b-x', reason: 'not_found' },
        ],
      })
    ).toEqual({
      kind: 'confirmed',
      confirmed: 1,
      failed: [
        { name: 'b-2.md', reason: 'not_proposed' },
        { name: 'b-x', reason: 'not_found' },
      ],
    });
  });
});
