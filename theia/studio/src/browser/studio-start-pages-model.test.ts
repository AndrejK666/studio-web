import {
    agentsSection, agoText, branchOfStatusTitle, desktopRepositoryRow, modeOverview, orcaRow, projectWorktrees, recentFileRows,
    relativeTo, repositoriesSection, scmRepositoryRow, worktreeRows, worktreesSection, LIST_MAX,
} from './studio-start-pages-model';
import type { OrcaWorktree } from '../common/orca-protocol';

const NOW = Date.parse('2026-09-30T12:00:00Z');

describe('the Development page', () => {
    it('says where a desktop clone stands against its remote, and tags what needs doing', () => {
        const row = desktopRepositoryRow({ name: 'api', path: 'C:/ws/api', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0, changed: 0, remote: 'https://git.example/api' });
        expect(row.name).toBe('api');
        expect(row.detail).toBe('main: 2 to push against origin/main');
        expect(row.tag).toBe('2 to push');
        expect(row.folder).toBe('https://git.example/api');
        const dirty = desktopRepositoryRow({ name: 'web', path: 'C:/ws/web', branch: 'feat', changed: 3 });
        expect(dirty.detail).toBe('feat, not pushed yet · 3 files changed, not committed');
        expect(dirty.tag).toBe('3 changed');
        expect(desktopRepositoryRow({ name: 'x', path: 'x', branch: 'main', upstream: 'origin/main', changed: 0 }).tag).toBeUndefined();
    });

    it('reads the branch out of a status-bar title', () => {
        expect(branchOfStatusTitle('$(git-branch) main*')).toBe('main');
        expect(branchOfStatusTitle('$(git-branch) feat/x+')).toBe('feat/x');
        expect(branchOfStatusTitle('$(sync)')).toBeUndefined();
        expect(branchOfStatusTitle(undefined)).toBeUndefined();
    });

    it('lists a session repository by its folder, branch and uncommitted files, counting a file once', () => {
        const row = scmRepositoryRow({
            rootPath: '/home/project/api',
            label: 'Git',
            statusTitles: ['$(sync)', '$(git-branch) main*'],
            changed: ['file:///home/project/api/a.ts', 'file:///home/project/api/a.ts', 'file:///home/project/api/b.ts'],
        }, ['/home/project']);
        expect(row).toEqual(expect.objectContaining({ name: 'api', detail: 'on main · 2 files changed, not committed', tag: '2 changed' }));
        const clean = scmRepositoryRow({ rootPath: '/home/project', label: 'Git', statusTitles: [], changed: [] }, ['/home/project']);
        expect(clean.name).toBe('project');
        expect(clean.detail).toBe('Git · nothing to commit');
        expect(clean.tag).toBeUndefined();
    });

    it('says why the repository list is empty, and which kind of empty', () => {
        expect(repositoriesSection([], 'none', { hasProject: false }).empty).toBe('No project is open.');
        expect(repositoriesSection([], 'desktop', { hasProject: true }).empty).toMatch(/holds no git repository/);
        expect(repositoriesSection([], 'session', { hasProject: true }).empty).toMatch(/Source control/);
        const two = repositoriesSection([{ name: 'a' }, { name: 'b' }], 'desktop', { hasProject: true, note: 'n' });
        expect(two.count).toBe('2 repositories');
        expect(two.note).toBe('n');
    });

    it('lists the files last opened, newest first, once each, only inside the project', () => {
        const root = 'file:///c%3A/ws';
        const uris = [
            `${root}/src/a.ts`,
            'file:///c%3A/elsewhere/x.ts',
            `${root}/src/b%20c.ts`,
            `${root}/src/a.ts`,
            `${root}/README.md`,
        ];
        const rows = recentFileRows(uris, [root]);
        expect(rows.map(r => r.name)).toEqual(['README.md', 'a.ts', 'b c.ts']);
        expect(rows[2].folder).toBe('src');
        expect(rows[1].open).toBe(`${root}/src/a.ts`);
        expect(recentFileRows([], [root])).toEqual([]);
        const many = Array.from({ length: 20 }, (_, n) => `${root}/f${n}.ts`);
        expect(recentFileRows(many, [root])).toHaveLength(LIST_MAX);
    });

    it('takes a path relative to the root that holds it, however the slashes run', () => {
        expect(relativeTo(['C:\\ws'], 'c:/ws/api/x')).toBe('api/x');
        expect(relativeTo(['/ws/'], '/ws')).toBe('');
        expect(relativeTo(['/a'], '/b/c')).toBe('/b/c');
    });
});

describe('the Agent development page', () => {
    it('says whether Orca runs, and which agents it can start', () => {
        expect(orcaRow({ reachable: true, state: 'ready', appVersion: '1.2', desktopRunning: true, agents: ['claude', 'codex'] }, undefined))
            .toEqual({ name: 'Orca', detail: 'Running 1.2 · agents: claude, codex', tag: 'ready' });
        expect(orcaRow({ reachable: false, state: 'unknown', desktopRunning: false, cliMissing: true, host: 'local' }, undefined).detail)
            .toBe('Not installed on this computer');
        expect(orcaRow({ reachable: false, state: 'unknown', desktopRunning: false, cliMissing: true, host: 'session' }, undefined).detail)
            .toBe('Not in this session\'s image');
        expect(orcaRow({ reachable: false, state: 'unknown', desktopRunning: false, host: 'local' }, undefined).detail)
            .toMatch(/Not running/);
        expect(orcaRow(undefined, 'Orca did not answer in 5 s').detail).toBe('Could not be asked: Orca did not answer in 5 s');
    });

    it('lists the assistants this build can open under Orca', () => {
        const section = agentsSection({ name: 'Orca' }, [{ label: 'Claude Code', command: 'studio.assistant.reveal', args: ['claude'] }]);
        expect(section.rows.map(r => r.name)).toEqual(['Orca', 'Claude Code']);
        expect(section.rows[1]).toEqual(expect.objectContaining({ command: 'studio.assistant.reveal', args: ['claude'] }));
        expect(agentsSection(undefined, []).rows).toEqual([]);
        expect(agentsSection(undefined, []).empty).toMatch(/No coding agent/);
    });

    it('puts the worktrees an agent touched last first, and the main checkouts after', () => {
        const wt = (id: string, extra: Partial<OrcaWorktree>): OrcaWorktree => ({
            id, path: `/w/${id}`, branch: id, displayName: id, comment: '', status: '', isMain: false, ...extra,
        });
        const rows = worktreeRows([
            wt('main', { isMain: true, lastActivityAt: NOW }),
            wt('old', { lastActivityAt: NOW - 3 * 3600_000, status: 'done' }),
            wt('new', { lastActivityAt: NOW - 120_000, status: 'in-progress', comment: 'fix the login' }),
        ], NOW);
        expect(rows.map(r => r.name)).toEqual(['new', 'old', 'main']);
        expect(rows[0]).toEqual(expect.objectContaining({ tag: 'in-progress', meta: '2 min ago', detail: 'fix the login' }));
        expect(rows[2].tag).toBeUndefined();
    });

    it('keeps the worktrees of this project\'s repositories and counts the rest of a member\'s Orca', () => {
        const wt = (id: string, path: string, repoId: string, isMain = false): OrcaWorktree => ({
            id, path, branch: id, displayName: id, comment: '', status: '', isMain, repoId,
        });
        const { worktrees, elsewhere } = projectWorktrees(
            [wt('main', 'C:/ws/api', 'r1', true), wt('task', 'C:/orca/wt/task', 'r1'), wt('other', 'C:/Repos/x', 'r2', true)],
            [{ id: 'r1', path: 'C:/ws/api', displayName: 'api' }, { id: 'r2', path: 'C:/Repos/x', displayName: 'x' }],
            'c:\\ws',
        );
        expect(worktrees.map(w => w.id).sort()).toEqual(['main', 'task']);
        expect(elsewhere).toBe(1);
        const none = worktreesSection([], 0, { reachable: true, elsewhere: 6 });
        expect(none.empty).toMatch(/no worktree of this project/);
        expect(none.note).toBe('6 worktrees of other repositories are in the Agents panel.');
    });

    it('says why there are no worktrees', () => {
        expect(worktreesSection([], 0, { reachable: false }).empty).toMatch(/not running/);
        expect(worktreesSection([], 0, { reachable: true }).empty).toMatch(/No worktree yet/);
        expect(worktreesSection([], 0, { reachable: true, error: 'boom' }).empty).toBe('Orca could not list them: boom');
        const some = worktreesSection([{ name: 'a' }], 8, { reachable: true });
        expect(some.more).toBe(7);
        expect(some.count).toBe('8 worktrees');
    });

    it('says how long ago', () => {
        expect(agoText(NOW - 10_000, NOW)).toBe('just now');
        expect(agoText(NOW - 5 * 3600_000, NOW)).toBe('5 h ago');
        expect(agoText(NOW - 49 * 3600_000, NOW)).toBe('2 days ago');
        expect(agoText(undefined, NOW)).toBe('');
    });
});

describe('the Full functionality page', () => {
    it('lists every other mode with the thing it starts with', () => {
        const modes = [
            { role: 'docs', label: 'Doc editing', title: 'Write', perspective: 'studio.documents' },
            { role: 'building', label: 'Building', title: 'Compose', perspective: 'gearbox.product' },
            { role: 'full', label: 'Full functionality', title: 'All', perspective: 'studio.full' },
        ];
        const rows = modeOverview(modes, { docs: { label: 'New document', command: 'studio.document.new' } });
        expect(rows.map(r => r.role)).toEqual(['docs', 'building']);
        expect(rows[0].primary).toEqual({ label: 'New document', command: 'studio.document.new' });
        expect(rows[1].primary).toBeUndefined();
    });
});
