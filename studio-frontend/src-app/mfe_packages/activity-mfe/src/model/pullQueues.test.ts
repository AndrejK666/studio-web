import { describe, expect, it } from 'vitest';
import type { OpenPullRequest } from '@constructor-studio/mfe-shared';
import { pullQueues } from './pullQueues';

function pull(id: string, fields: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    id,
    number: Number(id),
    title: `Pull ${id}`,
    waiting: 'review',
    waiting_on: [],
    reviewers: [],
    repo: null,
    url: null,
    author: null,
    created_at: null,
    updated_at: null,
    days_open: null,
    ...fields,
  };
}

describe('pullQueues', () => {
  it('combines verified aliases and includes shared requests in each matching queue', () => {
    const alex = { login: 'alex', user_id: 'alex-id', display_name: 'Alex' };
    const alias = { login: 'alex-work', user_id: 'alex-id' };
    const blake = { login: 'Blake', user_id: null };
    const queues = pullQueues([
      pull('1', { waiting_on: [alex, alias, blake], waiting_on_teams: ['Platform'] }),
      pull('2', { waiting_on: [alias, { ...blake, login: 'blake' }] }),
      pull('3', { waiting: 'nobody' }),
      pull('4'),
    ]);
    expect(queues[0]?.key).toBe('nobody');
    expect(queues.map(({ key, pulls }) => [key, pulls.map(({ id }) => id)])).toEqual([
      ['nobody', ['3']],
      ['member:alex-id', ['1', '2']],
      ['login:blake', ['1', '2']],
      ['unknown', ['4']],
      ['team:platform', ['1']],
    ]);
  });
});
