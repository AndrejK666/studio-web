import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { argumentsOf, StudioCliServiceImpl } from './studio-cli-service';
import type { CfsCommand } from './cfs-command';

/** A `cfs` that prints what it was asked and where, and fails when asked to. */
class FakeCli extends StudioCliServiceImpl {
    constructor(protected readonly fake: CfsCommand) {
        super();
    }
    protected override command(): CfsCommand {
        return this.fake;
    }
}

describe('the Constructor Studio CLI as IDE commands', () => {
    let root: string;
    let cli: FakeCli;

    beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'studio-cli-')));
        const script = path.join(root, 'fake-cfs.js');
        await fs.writeFile(script, [
            'const args = process.argv.slice(2);',
            'process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }));',
            'if (args[0] === "validate") { process.stderr.write("2 errors"); process.exit(3); }',
        ].join('\n'), 'utf8');
        cli = new FakeCli({ executable: process.execPath, prefixArguments: [script], identity: 'fake cfs', engine: 'v1.6.2' });
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('owns every command line; init is pinned the way the kit installer pins it', () => {
        expect(argumentsOf('validate', {})).toEqual(['validate']);
        expect(argumentsOf('version', {})).toEqual(['--version']);
        expect(argumentsOf('init', { engine: 'v1.6.2' })).toEqual([
            'init', '--yes', '--migrate-from-cypilot=no', '--update-legacy-studio=no', '--version', 'v1.6.2',
        ]);
        expect(argumentsOf('init', {})).not.toContain('--version');
    });

    it('finds the checkout itself, or the checkouts side by side in a workspace', async () => {
        const repo = path.join(root, 'repo');
        await fs.mkdir(path.join(repo, '.git'), { recursive: true });
        expect(await cli.targets(repo)).toEqual([{ path: repo, name: 'repo', initialized: false }]);

        const docs = path.join(root, 'docs');
        await fs.mkdir(path.join(docs, '.cf-studio'), { recursive: true });
        await fs.mkdir(path.join(root, 'not-a-repo'));
        expect((await cli.targets(root)).map(t => [t.name, t.initialized])).toEqual([['docs', true], ['repo', false]]);

        expect(await cli.targets('relative/path')).toEqual([]);
        expect(await cli.targets(path.join(root, 'missing'))).toEqual([]);
    });

    it('runs the command in the checkout and reports its output and exit code', async () => {
        const repo = path.join(root, 'repo');
        await fs.mkdir(path.join(repo, '.git'), { recursive: true });

        const doctor = await cli.run('doctor', repo);
        expect(doctor).toMatchObject({ command: 'doctor', commandLine: 'cfs doctor', cwd: repo, identity: 'fake cfs', exitCode: 0 });
        expect(JSON.parse(doctor.stdout)).toEqual({ args: ['doctor'], cwd: repo });

        const validate = await cli.run('validate', repo);
        expect(validate).toMatchObject({ exitCode: 3, stderr: '2 errors' });
        expect(validate.error).toBeUndefined();
    });

    it('never runs init over a prepared checkout', async () => {
        const repo = path.join(root, 'repo');
        await fs.mkdir(path.join(repo, '.cf-studio'), { recursive: true });

        const run = await cli.run('init', repo);

        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain('already initialized');
    });

    it('refuses what is not one of its commands, or not a checkout', async () => {
        await expect(cli.run('rm -rf' as never, root)).rejects.toThrow('not a Constructor Studio CLI command');
        await expect(cli.run('doctor', 'relative')).rejects.toThrow('absolute path');
        await expect(cli.run('doctor', root)).rejects.toThrow('is not a checkout');
    });

    it('says how to get cfs when there is none', async () => {
        const repo = path.join(root, 'repo');
        await fs.mkdir(path.join(repo, '.git'), { recursive: true });
        const missing = new FakeCli({ executable: path.join(root, 'no-such-cfs'), prefixArguments: [], identity: 'cfs' });

        const run = await missing.run('doctor', repo);

        expect(run.exitCode).toBeNull();
        expect(run.error).toContain('install the Constructor Studio CLI');
    });
});
