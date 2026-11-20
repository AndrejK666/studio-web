import type { OpenPullRequest } from '@constructor-studio/mfe-shared';

interface PullQueue {
  key: string;
  name: string | null;
  pulls: OpenPullRequest[];
}

export function pullQueues(items: readonly OpenPullRequest[]): PullQueue[] {
  const queues = new Map<string, PullQueue>();
  const add = (key: string, name: string | null, pull: OpenPullRequest) => {
    const queue = queues.get(key) ?? { key, name, pulls: [] };
    if (!queue.pulls.some(({ id }) => id === pull.id)) queue.pulls.push(pull);
    queues.set(key, queue);
  };

  for (const pull of items) {
    if (pull.waiting === 'nobody') {
      add('nobody', null, pull);
      continue;
    }
    for (const person of pull.waiting_on) {
      const key = person.user_id ? `member:${person.user_id}` : `login:${person.login.toLowerCase()}`;
      add(key, person.display_name?.trim() || person.login, pull);
    }
    for (const team of pull.waiting_on_teams ?? []) add(`team:${team.toLowerCase()}`, team, pull);
    if (pull.waiting_on.length === 0 && !pull.waiting_on_teams?.length) add('unknown', null, pull);
  }
  return [...queues.values()].sort((a, b) =>
    Number(b.key === 'nobody') - Number(a.key === 'nobody') ||
    b.pulls.filter((p) => p.waiting !== 'draft').length - a.pulls.filter((p) => p.waiting !== 'draft').length ||
    (a.name ?? '').localeCompare(b.name ?? '')
  );
}
