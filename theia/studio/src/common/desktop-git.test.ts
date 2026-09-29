import { describePush, describeSync, pushTargetOf, repositoryLine, type DesktopGitRepository } from './desktop-git';

const repo = (name: string, extra: Partial<DesktopGitRepository> = {}): DesktopGitRepository => ({
    name, path: `C:\\p\\${name}`, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changed: 0, ...extra,
});

describe('which clone a Push pushes', () => {
    it('is the one Source Control selected, whatever the slashes and case', () => {
        const target = pushTargetOf([repo('a'), repo('b')], 'c:/P/b/');
        expect(target).toEqual({ repository: repo('b') });
    });

    it('is the only one, or the member\'s choice among several', () => {
        expect(pushTargetOf([repo('a')], undefined)).toEqual({ repository: repo('a') });
        expect(pushTargetOf([repo('a'), repo('b')], 'C:\\elsewhere')).toEqual({ choose: [repo('a'), repo('b')] });
        expect(pushTargetOf([], undefined)).toBeUndefined();
    });
});

describe('what Sync says', () => {
    it('is one notification, a warning when anything was left or failed', () => {
        expect(describeSync([
            { name: 'a', path: 'a', outcome: 'updated', message: 'main fast-forwarded by 2 commits from origin/main' },
            { name: 'b', path: 'b', outcome: 'diverged', message: 'main and origin/main have both moved' },
        ])).toEqual({
            level: 'warn',
            text: 'Sync: 1 of 2 repositories updated. a: main fast-forwarded by 2 commits from origin/main. b: main and origin/main have both moved.',
        });
        expect(describeSync([{ name: 'a', path: 'a', outcome: 'up-to-date', message: 'main is up to date with origin/main' }]))
            .toEqual({ level: 'info', text: 'Sync a: main is up to date with origin/main.' });
    });

    it('says what to do when the folder has no repository', () => {
        expect(describeSync([]).text).toContain('Open a project from the Constructor Studio view');
    });
});

describe('what Push says', () => {
    it('is an error when it failed, else news', () => {
        expect(describePush({ name: 'a', path: 'a', outcome: 'failed', message: 'push to origin/main failed: x' }).level).toBe('error');
        expect(describePush({ name: 'a', path: 'a', outcome: 'pushed', message: 'pushed main to origin/main' }))
            .toEqual({ level: 'info', text: 'Push a: pushed main to origin/main.' });
    });
});

describe('a clone\'s line in Sources', () => {
    it('says where the branch stands and what is not committed', () => {
        expect(repositoryLine(repo('a'))).toBe('main: up to date with origin/main');
        expect(repositoryLine(repo('a', { ahead: 2, behind: 1, changed: 3 })))
            .toBe('main: 2 to push, 1 to pull against origin/main · 3 files changed, not committed');
        expect(repositoryLine(repo('a', { upstream: undefined }))).toBe('main, not pushed yet');
        expect(repositoryLine(repo('a', { branch: undefined }))).toBe('detached HEAD');
    });
});
