import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, type ProjectDraft } from '../model/projectDraft';
import { creationBody, keyFor } from './wizardEffects';

const draft: ProjectDraft = {
  ...EMPTY_DRAFT,
  name: '  Shop  ',
  goal: ' A shop for tea. ',
  ownerId: 'u1',
  typeKit: 'gears-project',
};

describe('the project the server is asked to create', () => {
  it('is the draft in the route words: trimmed, with its type, and no mode or sources -- the type decides', () => {
    expect(creationBody('w1', draft, 'k')).toEqual({
      workspace_id: 'w1',
      name: 'Shop',
      brief: 'A shop for tea.',
      owner_id: 'u1',
      project_type_kit: 'gears-project',
      idempotency_key: 'k',
    });
  });

  it('leaves out what the draft does not say', () => {
    expect(creationBody('w1', { ...EMPTY_DRAFT, name: 'Shop' }, 'k')).toEqual({
      workspace_id: 'w1',
      name: 'Shop',
      idempotency_key: 'k',
    });
  });

  it('keeps one key for the same draft sent again, and another for another draft', () => {
    const first = keyFor('w1', draft);
    expect(keyFor('w1', draft)).toBe(first);
    expect(keyFor('w1', { ...draft, name: 'Other' })).not.toBe(first);
    expect(keyFor('w2', draft)).not.toBe(first);
  });

  it('sends exactly one project type kit and gives another type its own creation key', () => {
    const gears = { ...draft, typeKit: 'gears-project' };
    const research = { ...draft, typeKit: 'constructor-research' };
    expect(creationBody('w1', gears, 'k').project_type_kit).toBe('gears-project');
    expect(creationBody('w1', research, 'k').project_type_kit).toBe('constructor-research');
    expect(keyFor('w1', gears)).not.toBe(keyFor('w1', research));
  });
});
