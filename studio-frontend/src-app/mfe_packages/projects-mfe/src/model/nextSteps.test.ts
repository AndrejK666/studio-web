import { describe, expect, it } from 'vitest';
import type { ProjectTypeKit } from '../api/ProjectStatusApiService';
import type { ProjectPathStep } from './projectStatus';
import {
  fieldsAwaited,
  isFieldSet,
  isStepDone,
  pendingNextSteps,
  stepField,
  typeOf,
  withDismissed,
} from './nextSteps';

const gears: ProjectTypeKit = {
  slug: 'gears-project',
  name: 'Gears project',
  description: '',
  next_steps: [
    { id: 'connect-repositories', label: 'Connect', description: '', route: '/projects/sources', done_when: 'repos' },
    { id: 'compose-product', label: 'Compose', description: '', route: '/product', done_when: 'product' },
  ],
};
const research: ProjectTypeKit = {
  slug: 'constructor-research',
  name: 'Constructor Research project',
  description: '',
  next_steps: [{ id: 'connect-research-project', label: 'Connect Research', description: '', route: '/constructor-research' }],
};

const mna: ProjectTypeKit = {
  slug: 'mna',
  name: 'M&A deal',
  description: '',
  next_steps: [
    { id: 'connect-target-repositories', label: 'Connect', description: '', route: '/projects/sources', done_when: 'repos' },
    { id: 'fill-in-thesis', label: 'Thesis', description: '', route: '/deal', done_when: 'field:thesis' },
    { id: 'review-evidence', label: 'Review', description: '', route: '/deal' },
  ],
};

const step = (id: string, state: ProjectPathStep['state']): ProjectPathStep => ({
  step: id,
  title: id,
  state,
  flow: state,
  status: '',
  tab: 'sources',
  action: '',
});

describe("a project type's next steps", () => {
  it('belong to the type its configuration names, and to none for a project without one', () => {
    expect(typeOf([gears, research], 'constructor-research')).toBe(research);
    expect(typeOf([gears, research], undefined)).toBeNull();
    expect(typeOf([gears], 'mna')).toBeNull();
    expect(typeOf(undefined, 'gears-project')).toBeNull();
  });

  it('go once the path step they name is done', () => {
    expect(pendingNextSteps(gears, [], [step('repos', 'current')]).map((s) => s.id)).toEqual([
      'connect-repositories',
      'compose-product',
    ]);
    expect(pendingNextSteps(gears, [], [step('repos', 'done'), step('product', 'todo')]).map((s) => s.id)).toEqual([
      'compose-product',
    ]);
    // An unknown step is not a done one.
    expect(pendingNextSteps(gears, [], [step('repos', 'unknown')])).toHaveLength(2);
  });

  it('go once dismissed, and a step without a condition stays until then', () => {
    expect(pendingNextSteps(research, undefined, [])).toHaveLength(1);
    expect(pendingNextSteps(research, ['connect-research-project'], [])).toEqual([]);
    expect(pendingNextSteps(null, [], [])).toEqual([]);
  });

  it('read a field step by its name, and nothing else as one', () => {
    expect(stepField(mna.next_steps![1])).toBe('thesis');
    expect(stepField(mna.next_steps![0])).toBeNull();
    expect(stepField(mna.next_steps![2])).toBeNull();
    expect(stepField({ id: 'x', label: '', description: '', route: '/', done_when: 'field:' })).toBeNull();
  });

  it('count a field as set when it holds something', () => {
    expect(isFieldSet('Buy the platform')).toBe(true);
    expect(isFieldSet('  ')).toBe(false);
    expect(isFieldSet(null)).toBe(false);
    expect(isFieldSet(undefined)).toBe(false);
    expect(isFieldSet([])).toBe(false);
    expect(isFieldSet(['a'])).toBe(true);
    expect(isFieldSet(0)).toBe(true);
    expect(isFieldSet(false)).toBe(true);
  });

  it('go once the project field they wait on is set, and stay while it is unread', () => {
    const thesis = mna.next_steps![1];
    expect(isStepDone(thesis, [], undefined)).toBe(false);
    expect(isStepDone(thesis, [], {})).toBe(false);
    expect(isStepDone(thesis, [], { thesis: '' })).toBe(false);
    expect(isStepDone(thesis, [], { thesis: 'Why we buy' })).toBe(true);
    // A path step named like the field does not make it done.
    expect(isStepDone(thesis, [step('field:thesis', 'done')], undefined)).toBe(false);
    expect(
      pendingNextSteps(mna, [], [step('repos', 'done')], { thesis: 'Why we buy' }).map((s) => s.id)
    ).toEqual(['review-evidence']);
    expect(pendingNextSteps(mna, [], [step('repos', 'done')]).map((s) => s.id)).toEqual([
      'fill-in-thesis',
      'review-evidence',
    ]);
  });

  it('ask for the fields only steps not dismissed wait on', () => {
    expect(fieldsAwaited(mna, [])).toEqual(['thesis']);
    expect(fieldsAwaited(mna, ['fill-in-thesis'])).toEqual([]);
    expect(fieldsAwaited(gears, [])).toEqual([]);
    expect(fieldsAwaited(null, [])).toEqual([]);
  });

  it('keeps a dismissal once', () => {
    expect(withDismissed(undefined, 'a')).toEqual(['a']);
    expect(withDismissed(['a'], 'a')).toEqual(['a']);
    expect(withDismissed(['a'], 'b')).toEqual(['a', 'b']);
  });
});
