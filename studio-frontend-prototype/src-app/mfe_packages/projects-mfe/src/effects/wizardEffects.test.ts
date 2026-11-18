import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, type ProjectDraft } from '../model/projectDraft';
import { creationBody, keyFor } from './wizardEffects';

const draft: ProjectDraft = {
  ...EMPTY_DRAFT,
  name: '  Shop  ',
  goal: ' A shop for tea. ',
  ownerId: 'u1',
  mode: 'modernize',
  sources: [
    { id: '1', fullPath: 'acme/shop', cloneUrl: 'https://github.com/acme/shop.git', connectionId: 'c1', defaultBranch: 'main' },
    { id: '2', fullPath: 'acme/web', cloneUrl: 'https://github.com/acme/web.git', connectionId: 'c1' },
  ],
};

describe('the project the server is asked to create', () => {
  it('is the draft in the route words: trimmed, with its sources and their default branches', () => {
    expect(creationBody('w1', draft, 'k')).toEqual({
      workspace_id: 'w1',
      name: 'Shop',
      mode: 'modernize',
      brief: 'A shop for tea.',
      owner_id: 'u1',
      idempotency_key: 'k',
      sources: [
        { connection_id: 'c1', full_path: 'acme/shop', clone_url: 'https://github.com/acme/shop.git', default_branch: 'main' },
        { connection_id: 'c1', full_path: 'acme/web', clone_url: 'https://github.com/acme/web.git' },
      ],
    });
  });

  it('leaves out what the draft does not say, and starts from scratch by default', () => {
    expect(creationBody('w1', { ...EMPTY_DRAFT, name: 'Shop' }, 'k')).toEqual({
      workspace_id: 'w1',
      name: 'Shop',
      mode: 'greenfield',
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
