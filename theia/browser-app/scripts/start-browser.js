'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep the pinned VS Code Git extension in the runtime plugin set. It owns the
// native SCM provider consumed by Theia's Changes and Graph views.
const DISABLED_RUNTIME_PLUGINS = new Set();

function resolveWorkspaceDirectory(argv, browserAppDir) {
    for (let index = argv.length - 1; index >= 0; index -= 1) {
        const argument = argv[index];
        if (!argument || argument.startsWith('-')) {
            continue;
        }
        const candidate = path.resolve(browserAppDir, argument);
        if (!fs.existsSync(candidate)) {
            continue;
        }
        const stat = fs.statSync(candidate);
        return stat.isDirectory() ? candidate : path.dirname(candidate);
    }
    throw new Error(
        'A workspace path is required. Example: npm run start:browser -- --hostname=127.0.0.1 --port=3003 /absolute/workspace/path'
    );
}

function normalizeLoopbackHostname(argv) {
    const normalized = [...argv];
    let hasHostname = false;
    for (let index = 0; index < normalized.length; index += 1) {
        const argument = normalized[index];
        if (argument.startsWith('--hostname=')) {
            hasHostname = true;
        } else if (argument === '--hostname') {
            hasHostname = true;
        }
        if (argument === '--hostname=127.0.0.1' || argument === '--hostname=::1') {
            normalized[index] = '--hostname=localhost';
        } else if (
            argument === '--hostname'
            && (normalized[index + 1] === '127.0.0.1' || normalized[index + 1] === '::1')
        ) {
            normalized[index + 1] = 'localhost';
        }
    }
    if (!hasHostname) {
        normalized.unshift('--hostname=localhost');
    }
    return normalized;
}

function stageRuntimePlugins(sourceDirectory, targetDirectory, disabledPlugins = DISABLED_RUNTIME_PLUGINS) {
    fs.mkdirSync(targetDirectory, { recursive: true });
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory() || disabledPlugins.has(entry.name)) {
            continue;
        }
        fs.symlinkSync(
            path.join(sourceDirectory, entry.name),
            path.join(targetDirectory, entry.name),
            'junction'
        );
    }
}

/*
 * The repository that contains the workspace, or `undefined` when there is
 * none — an ordinary answer, not a failure.
 *
 * A managed Studio workspace is a CONTAINER for source checkouts, not a
 * repository: /workspace holds .cf-workspace.toml and one directory per
 * source, each its own clone. This launcher used to demand a repository here,
 * a leftover from the single-checkout POC where one repository WAS the
 * workspace, and the session entrypoint satisfied the demand by git-initialising
 * /workspace — README, first commit and all. That synthetic repository then sat
 * in Source Control beside the real ones, which is the opposite of what a person
 * wants there: the repositories worth seeing are the project's.
 *
 * Only the git write modes genuinely need a repository, and they say so
 * themselves in applyDefaultEnv.
 */
function resolveRepositoryRoot(workspaceDirectory) {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: workspaceDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error || result.status !== 0) {
        return undefined;
    }
    return result.stdout.trim() || undefined;
}

function createCheckoutKey(repositoryRoot, workspaceRoot = repositoryRoot) {
    return crypto.createHash('sha256')
        .update(repositoryRoot)
        .update('\0')
        .update(workspaceRoot)
        .digest('hex')
        .slice(0, 12);
}

function resolveGitDefaults(repositoryRoot) {
    const fetchSourceUrl = validateResolvedRemoteUrl(
        readGitValue(repositoryRoot, ['config', '--local', '--get', 'remote.origin.url'], 'origin source fetch URL'),
        'origin source fetch URL'
    );
    const pushSourceUrl = validateResolvedRemoteUrl(
        readOptionalGitValue(repositoryRoot, ['config', '--local', '--get', 'remote.origin.pushurl']) ?? fetchSourceUrl,
        'origin source push URL'
    );
    const fetchUrl = validateResolvedRemoteUrl(
        readGitValue(repositoryRoot, ['remote', 'get-url', 'origin'], 'origin fetch URL'),
        'origin fetch URL'
    );
    const pushUrl = validateResolvedRemoteUrl(
        readGitValue(repositoryRoot, ['remote', 'get-url', '--push', 'origin'], 'origin push URL'),
        'origin push URL'
    );
    return {
        branch: readGitValue(repositoryRoot, ['branch', '--show-current'], 'current branch'),
        remote: 'origin',
        // Capture both the repository-owned source URLs and their resolved
        // forms while the launcher still has the user's Git config. The backend
        // recreates only these URL rewrites as command-scoped configuration.
        fetchSourceUrl,
        pushSourceUrl,
        fetchUrl,
        pushUrl,
        authorName: readGitValue(repositoryRoot, ['config', '--get', 'user.name'], 'user.name'),
        authorEmail: readGitValue(repositoryRoot, ['config', '--get', 'user.email'], 'user.email')
    };
}

function validateResolvedRemoteUrl(value, label) {
    if (value.length > 2048 || value.startsWith('-') || value.includes('=') || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error(`Resolved Git ${label} is invalid.`);
    }
    return value;
}

function readGitValue(repositoryRoot, args, label) {
    const value = execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit']
    }).trim();
    if (!value) {
        throw new Error(`Unable to resolve Git ${label} for Studio push mode.`);
    }
    return value;
}

function readOptionalGitValue(repositoryRoot, args) {
    const result = spawnSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit']
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status === 1) {
        return undefined;
    }
    if (result.status !== 0) {
        throw new Error(`git ${args[0] ?? 'command'} failed with exit code ${result.status ?? -1}`);
    }
    const value = result.stdout.trim();
    return value || undefined;
}

function applyDefaultEnv(
    env,
    repositoryRoot,
    workspaceRoot,
    checkoutKey,
    gitDefaultsFactory = () => resolveGitDefaults(repositoryRoot)
) {
    if (env.THEIA_WEBVIEW_EXTERNAL_ENDPOINT === undefined) {
        env.THEIA_WEBVIEW_EXTERNAL_ENDPOINT = '{{uuid}}.webview.{{hostname}}';
    }
    if (env.STUDIO_ACTOR_ID === undefined) {
        env.STUDIO_ACTOR_ID = 'local-user';
    }
    if (env.STUDIO_WORKSPACE_ID === undefined) {
        env.STUDIO_WORKSPACE_ID = `theia-poc-${checkoutKey}`;
    }
    if (env.STUDIO_REPOSITORY_ROOT === undefined) {
        // Without a repository the workspace root is its own boundary. Keeping
        // the two equal matters downstream: RepositoryDiscoveryService only adds
        // the configured root as a scan candidate when it DIFFERS from the
        // workspace root, so a container root contributes nothing of its own and
        // the registry lists exactly the project's checkouts.
        env.STUDIO_REPOSITORY_ROOT = repositoryRoot ?? workspaceRoot;
    }
    if (env.STUDIO_WORKSPACE_ROOT === undefined) {
        env.STUDIO_WORKSPACE_ROOT = workspaceRoot;
    }
    if (env.STUDIO_DATA_DIR === undefined) {
        env.STUDIO_DATA_DIR = path.join(os.tmpdir(), 'theia-studio-poc', checkoutKey);
    }
    if (env.STUDIO_GIT_MODE === undefined) {
        env.STUDIO_GIT_MODE = 'push';
    }
    if (env.STUDIO_GIT_MODE === 'commit' || env.STUDIO_GIT_MODE === 'push') {
        if (repositoryRoot === undefined) {
            throw new Error(
                'STUDIO_GIT_MODE=' + env.STUDIO_GIT_MODE + ' reads the branch, remote and identity from a git '
                + 'repository, but ' + workspaceRoot + ' is not inside one. A managed workspace keeps its sources '
                + 'in subdirectories and wants STUDIO_GIT_MODE=disabled.'
            );
        }
        const gitDefaults = gitDefaultsFactory();
        if (env.STUDIO_GIT_BRANCH === undefined) {
            env.STUDIO_GIT_BRANCH = gitDefaults.branch;
        }
        if (env.STUDIO_GIT_REMOTE === undefined) {
            env.STUDIO_GIT_REMOTE = gitDefaults.remote;
        }
        if (env.STUDIO_GIT_FETCH_URL === undefined) {
            env.STUDIO_GIT_FETCH_URL = gitDefaults.fetchUrl;
        }
        if (env.STUDIO_GIT_PUSH_URL === undefined) {
            env.STUDIO_GIT_PUSH_URL = gitDefaults.pushUrl;
        }
        if (env.STUDIO_GIT_FETCH_SOURCE_URL === undefined) {
            env.STUDIO_GIT_FETCH_SOURCE_URL = gitDefaults.fetchSourceUrl;
        }
        if (env.STUDIO_GIT_PUSH_SOURCE_URL === undefined) {
            env.STUDIO_GIT_PUSH_SOURCE_URL = gitDefaults.pushSourceUrl;
        }
        if (env.STUDIO_GIT_AUTHOR_NAME === undefined) {
            env.STUDIO_GIT_AUTHOR_NAME = gitDefaults.authorName;
        }
        if (env.STUDIO_GIT_AUTHOR_EMAIL === undefined) {
            env.STUDIO_GIT_AUTHOR_EMAIL = gitDefaults.authorEmail;
        }
    }
    return env;
}

function main(argv = process.argv.slice(2)) {
    const launchArgv = normalizeLoopbackHostname(argv);
    const browserAppDir = path.resolve(__dirname, '..');
    const workspaceDirectory = resolveWorkspaceDirectory(launchArgv, browserAppDir);
    const repositoryRoot = resolveRepositoryRoot(workspaceDirectory);
    // The key identifies the checkout on disk; a container root identifies
    // itself. For a workspace that used to carry a synthetic root repository
    // the two were already the same path, so no data directory moves.
    const checkoutKey = createCheckoutKey(repositoryRoot ?? workspaceDirectory, workspaceDirectory);
    const env = applyDefaultEnv({ ...process.env }, repositoryRoot, workspaceDirectory, checkoutKey);
    const theiaCli = require.resolve('@theia/cli/bin/theia.js');
    const runtimePluginsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theia-studio-plugins-'));
    stageRuntimePlugins(path.resolve(browserAppDir, '..', 'plugins'), runtimePluginsDirectory);
    let result;
    try {
        result = spawnSync(
            process.execPath,
            [theiaCli, 'start', `--plugins=local-dir:${runtimePluginsDirectory}`, ...launchArgv],
            {
                cwd: browserAppDir,
                env,
                stdio: 'inherit'
            }
        );
    } finally {
        fs.rmSync(runtimePluginsDirectory, { recursive: true, force: true });
    }

    if (result.error) {
        throw result.error;
    }
    if (result.signal) {
        console.error(`Theia launcher terminated by signal ${result.signal}.`);
        process.exitCode = 1;
        return;
    }
    if (typeof result.status === 'number') {
        process.exitCode = result.status;
        return;
    }
    process.exitCode = 1;
}

if (require.main === module) {
    main();
}

module.exports = {
    resolveWorkspaceDirectory,
    normalizeLoopbackHostname,
    stageRuntimePlugins,
    resolveRepositoryRoot,
    createCheckoutKey,
    resolveGitDefaults,
    validateResolvedRemoteUrl,
    applyDefaultEnv,
    main
};
