import { describe, expect, it } from 'vitest';
import type { ProjectTypeKit } from '../api/ProjectStatusApiService';
import type { ProjectPathStep } from './projectStatus';
import { pendingNextSteps, typeOf, withDismissed } from './nextSteps';

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

  it('keeps a dismissal once', () => {
    expect(withDismissed(undefined, 'a')).toEqual(['a']);
    expect(withDismissed(['a'], 'a')).toEqual(['a']);
    expect(withDismissed(['a'], 'b')).toEqual(['a', 'b']);
  });
});
