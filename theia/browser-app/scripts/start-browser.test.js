'use strict';

/*
 * The launcher's contract with a managed workspace: a workspace that is not a
 * git repository is an ordinary workspace.
 *
 * This used to be a hard failure, and the session entrypoint worked around it
 * by git-initialising /workspace. The cost showed up in the IDE: Source Control
 * listed the synthetic root beside the real checkouts, so a person opening a
 * project saw one repository more than the project has.
 */

const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { resolveRepositoryRoot, applyDefaultEnv } = require('./start-browser.js');

function makeTempDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'start-browser-test-'));
    // Git always answers with the real path: macOS hands out /var/folders
    // symlinks, Windows an 8.3 short name. `native` resolves both.
    return fs.realpathSync.native(directory);
}

test('a workspace outside any repository resolves to no repository root', () => {
    const workspace = makeTempDirectory();
    try {
        assert.equal(resolveRepositoryRoot(workspace), undefined);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('a workspace inside a repository still resolves to its root', () => {
    const workspace = makeTempDirectory();
    try {
        execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
        const nested = path.join(workspace, 'nested');
        fs.mkdirSync(nested);
        assert.equal(fs.realpathSync.native(resolveRepositoryRoot(nested)), workspace);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('without a repository the workspace root is its own boundary', () => {
    const env = applyDefaultEnv(
        { STUDIO_GIT_MODE: 'disabled' },
        undefined,
        '/workspace',
        'abc123',
        () => assert.fail('git defaults must not be read without a repository')
    );
    assert.equal(env.STUDIO_REPOSITORY_ROOT, '/workspace');
    assert.equal(env.STUDIO_WORKSPACE_ROOT, '/workspace');
});

test('a git write mode without a repository fails with a usable message', () => {
    assert.throws(
        () => applyDefaultEnv({ STUDIO_GIT_MODE: 'push' }, undefined, '/workspace', 'abc123'),
        /STUDIO_GIT_MODE=push .*\/workspace is not inside one/s
    );
});

test('a git write mode with a repository still reads its defaults', () => {
    const env = applyDefaultEnv(
        { STUDIO_GIT_MODE: 'commit' },
        '/srv/repo',
        '/srv/repo',
        'abc123',
        () => ({
            branch: 'main',
            remote: 'origin',
            fetchSourceUrl: 'https://example.invalid/repo.git',
            pushSourceUrl: 'https://example.invalid/repo.git',
            fetchUrl: 'https://example.invalid/repo.git',
            pushUrl: 'https://example.invalid/repo.git',
            authorName: 'Ada',
            authorEmail: 'ada@example.invalid'
        })
    );
    assert.equal(env.STUDIO_REPOSITORY_ROOT, '/srv/repo');
    assert.equal(env.STUDIO_GIT_BRANCH, 'main');
});
