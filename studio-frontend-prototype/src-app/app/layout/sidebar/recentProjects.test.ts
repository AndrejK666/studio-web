import { describe, expect, it } from 'vitest';
import { RECENT_PROJECTS_MAX, parseRecent, withRecent, type RecentProject } from './recentProjects';

const entry = (id: string, name = id.toUpperCase()): RecentProject => ({
  org: { id: 'o1', name: 'Acme' },
  workspace: { id: 'w1', name: 'Web' },
  project: { id, name },
});

describe('recent projects', () => {
  it('puts the project just opened first, once, and keeps five', () => {
    let list: RecentProject[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) list = withRecent(list, entry(id));
    expect(list.map((r) => r.project.id)).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(list).toHaveLength(RECENT_PROJECTS_MAX);
    list = withRecent(list, entry('c', 'Renamed'));
    expect(list.map((r) => r.project.id)).toEqual(['c', 'f', 'e', 'd', 'b']);
    expect(list[0]!.project.name).toBe('Renamed');
  });

  it('reads what a browser holds, dropping what it cannot read and repeats', () => {
    expect(parseRecent('nope')).toEqual([]);
    expect(
      parseRecent([entry('a'), { project: { id: 'x' } }, null, entry('a'), entry('b')]).map((r) => r.project.id)
    ).toEqual(['a', 'b']);
  });
});
