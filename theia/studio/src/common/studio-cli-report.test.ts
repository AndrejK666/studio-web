import { logOfCliRun, summarizeCliRun } from './studio-cli-report';
import type { StudioCliRun } from './studio-cli-protocol';

const run = (over: Partial<StudioCliRun>): StudioCliRun => ({
    command: 'validate',
    commandLine: 'cfs validate',
    cwd: '/w/studio-web',
    identity: 'cfs (Constructor Studio CLI extension)',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1234,
    ...over,
});

describe('telling a cfs run', () => {
    it('says a run that worked is done, and how long it took', () => {
        expect(summarizeCliRun(run({}), 'studio-web')).toEqual({ level: 'info', text: 'cfs validate in studio-web: done in 1.2 s' });
    });

    it('calls findings a warning with the last thing cfs said, not a failure of the tool', () => {
        expect(summarizeCliRun(run({ exitCode: 2, stdout: 'checking…\nFAIL: 3 errors\n' }), 'studio-web'))
            .toEqual({ level: 'warning', text: 'cfs validate in studio-web exited with 2: FAIL: 3 errors' });
    });

    it('calls a cfs that could not run an error, with the reason', () => {
        expect(summarizeCliRun(run({ exitCode: null, error: 'cfs was not found' }), 'studio-web'))
            .toEqual({ level: 'error', text: 'cfs validate did not run in studio-web: cfs was not found' });
    });

    it('names the version and which cfs answered', () => {
        expect(summarizeCliRun(run({ command: 'version', stdout: 'cfs 1.6.2\n' }), 'x').text)
            .toBe('cfs 1.6.2 (cfs (Constructor Studio CLI extension))');
    });

    it('logs what ran, where, with which cfs, then everything it said', () => {
        expect(logOfCliRun(run({ exitCode: 2, stdout: 'a\nb\n', stderr: 'c' }))).toEqual([
            '$ cfs validate',
            '  in /w/studio-web',
            '  with cfs (Constructor Studio CLI extension)',
            'a', 'b', 'c',
            '→ exit 2 after 1.2 s',
            '',
        ]);
    });
});
