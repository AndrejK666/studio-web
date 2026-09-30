import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import { cfsCommand, cfsEnvironment, type CfsCommand } from './cfs-command';
import {
    isStudioCliCommand,
    type StudioCliCommandId,
    type StudioCliRun,
    type StudioCliService,
    type StudioCliTarget,
} from '../common/studio-cli-protocol';

/** `cfs validate` on a large project reads every artifact; five minutes is generous, not endless. */
const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Each command's arguments, owned here. `init` takes the flags the kit
 * installer uses, so a checkout prepared from the ribbon is prepared the same
 * way as one a kit install prepared, pinned to the same engine.
 */
export function argumentsOf(command: StudioCliCommandId, cfs: Pick<CfsCommand, 'engine'>): string[] {
    switch (command) {
        case 'version':
            return ['--version'];
        case 'init':
            return [
                'init',
                '--yes',
                '--migrate-from-cypilot=no',
                '--update-legacy-studio=no',
                ...(cfs.engine ? ['--version', cfs.engine] : []),
            ];
        default:
            return [command];
    }
}

async function isDirectory(p: string): Promise<boolean> {
    try {
        return (await fs.stat(p)).isDirectory();
    } catch {
        return false;
    }
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function targetOf(dir: string): Promise<StudioCliTarget | undefined> {
    const initialized = await isDirectory(path.join(dir, '.cf-studio'));
    if (!initialized && !(await exists(path.join(dir, '.git')))) {
        return undefined;
    }
    return { path: dir, name: path.basename(dir), initialized };
}

@injectable()
export class StudioCliServiceImpl implements StudioCliService {
    /** The command to run: looked up per call, since the CLI extension may arrive while the IDE runs. */
    protected command(): CfsCommand {
        return cfsCommand();
    }

    async targets(root: string): Promise<StudioCliTarget[]> {
        if (typeof root !== 'string' || !path.isAbsolute(root) || !(await isDirectory(root))) {
            return [];
        }
        const own = await targetOf(root);
        if (own) {
            return [own];
        }
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        const found: StudioCliTarget[] = [];
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const target = await targetOf(path.join(root, entry.name));
                if (target) {
                    found.push(target);
                }
            }
        }
        return found.sort((a, b) => a.name.localeCompare(b.name));
    }

    async run(command: StudioCliCommandId, cwd: string): Promise<StudioCliRun> {
        if (!isStudioCliCommand(command)) {
            throw new Error(`not a Constructor Studio CLI command: ${String(command)}`);
        }
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
            throw new Error('cfs runs in a checkout named by its absolute path');
        }
        const target = await targetOf(cwd);
        if (!target) {
            throw new Error(`${cwd} is not a checkout: it holds neither .cf-studio nor .git`);
        }
        const cfs = this.command();
        const args = argumentsOf(command, cfs);
        const commandLine = `cfs ${args.join(' ')}`;
        const started = Date.now();
        if (command === 'init' && target.initialized) {
            // Not run: `cfs init` on a prepared checkout would rewrite its
            // Studio setup, the thing the kit installer is careful never to do.
            return {
                command, commandLine, cwd, identity: cfs.identity, exitCode: 0,
                stdout: `${target.name} is already initialized (.cf-studio is there); nothing to do.\n`,
                stderr: '', durationMs: 0,
            };
        }
        return new Promise(resolve => {
            execFile(cfs.executable, [...cfs.prefixArguments, ...args], {
                cwd,
                env: cfsEnvironment(cfs),
                timeout: RUN_TIMEOUT_MS,
                maxBuffer: MAX_OUTPUT_BYTES,
                windowsHide: true,
                shell: false,
            }, (error, stdout, stderr) => {
                const failure = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
                const exitCode = failure ? (typeof failure.code === 'number' ? failure.code : null) : 0;
                resolve({
                    command, commandLine, cwd, identity: cfs.identity, exitCode,
                    stdout: String(stdout ?? ''),
                    stderr: String(stderr ?? ''),
                    ...(failure && exitCode === null ? { error: describeFailure(failure, cfs) } : {}),
                    durationMs: Date.now() - started,
                });
            });
        });
    }
}

function describeFailure(error: NodeJS.ErrnoException & { killed?: boolean }, cfs: CfsCommand): string {
    if (error.code === 'ENOENT') {
        return `${cfs.identity} was not found: install the Constructor Studio CLI from the Extensions view`;
    }
    if (error.killed) {
        return `stopped after ${RUN_TIMEOUT_MS / 60_000} minutes`;
    }
    return error.message;
}
