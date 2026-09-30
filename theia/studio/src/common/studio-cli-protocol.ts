// The Constructor Studio CLI (`cfs`) as commands of the IDE: the ribbon's CLI
// group and the command palette.
//
// `cfs` was only reachable from a terminal, where a member had to know it was
// there, which of its thirty subcommands matter, and that the IDE's own copy
// (the CLI extension's, pinned to the session's engine) is not necessarily the
// one first on PATH. These are the handful a person runs on a checkout, run by
// the backend with the same command the kit installer uses.
//
// The browser names a command by id and never passes arguments: the backend
// owns each command line, so a page cannot turn this into running anything.

export const studioCliServicePath = '/services/studio-cli';
/** DI key for the proxy on the frontend and the impl on the backend. */
export const StudioCliService = Symbol('StudioCliService');

export const STUDIO_CLI_COMMANDS = ['validate', 'doctor', 'info', 'generate-agents', 'init', 'version'] as const;
export type StudioCliCommandId = (typeof STUDIO_CLI_COMMANDS)[number];

export function isStudioCliCommand(value: unknown): value is StudioCliCommandId {
    return typeof value === 'string' && (STUDIO_CLI_COMMANDS as readonly string[]).includes(value);
}

/** A folder `cfs` can run in: one checkout. */
export interface StudioCliTarget {
    readonly path: string;
    /** The folder's name, as a picker shows it. */
    readonly name: string;
    /** Whether `cfs init` has prepared it (`.cf-studio` is there). */
    readonly initialized: boolean;
}

export interface StudioCliRun {
    readonly command: StudioCliCommandId;
    /** How the command was launched, for the log: `cfs validate` in `<cwd>`. */
    readonly commandLine: string;
    readonly cwd: string;
    /** Which `cfs`: the CLI extension's, the configured one, or the one on PATH. */
    readonly identity: string;
    /** 0 on success; null when it could not be started or was stopped. */
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    /** Why it did not finish, when it did not: not found, timed out. */
    readonly error?: string;
    readonly durationMs: number;
}

export interface StudioCliService {
    /**
     * The checkouts under `root`: `root` itself when it is one (it holds
     * `.cf-studio` or `.git`), else its immediate subfolders that are -- a
     * session's workspace holds its repositories side by side.
     */
    targets(root: string): Promise<StudioCliTarget[]>;
    /** Run one of the commands in `cwd`, which must be a folder `targets` named. */
    run(command: StudioCliCommandId, cwd: string): Promise<StudioCliRun>;
}
