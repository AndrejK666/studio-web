// What the session entrypoint does with the workspace ROOT.
//
// The root of a managed workspace is a container: it holds .cf-workspace.toml
// and one directory per source, each its own clone. It used to be a git
// repository too, manufactured here because the Theia launcher refused to
// start outside a worktree — and that synthetic repository then sat in Source
// Control beside the real ones. A person opening a project saw one repository
// more than the project has, wearing the project's own name.
//
// Three things are asserted, each a way this can go wrong quietly: the root is
// left alone, a synthetic root left behind by an earlier image is retired
// rather than kept OR deleted, and a repository a person actually owns is
// never touched.
//
// Like the other entrypoint tests, the code under test is extracted from
// entrypoint.sh rather than copied, so it cannot drift from what ships.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const hasBash = (() => {
  const probe = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
})();

if (!hasBash) {
  // A Windows checkout outside Git Bash has no bash on PATH. CI runs on
  // Linux, so the assertions below are still enforced before merge.
  console.log('workspace root: skipped (no bash on PATH)');
} else {
  const entrypoint = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
  const match = entrypoint.match(/^# >>> studio:workspace-root$([\s\S]*?)^# <<< studio:workspace-root$/m);
  assert.ok(match, 'entrypoint must delimit the workspace-root phase with the studio:workspace-root markers');
  const block = match[1];

  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-root-test-'));
  const script = path.join(directory, 'workspace-root.sh');
  await writeFile(script, `#!/bin/bash\nset -euo pipefail\nWORKSPACE="$1"\n${block}\n`, { mode: 0o755 });

  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };

  const run = (workspace, env = {}) => {
    const result = spawnSync('bash', [script, workspace], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    assert.equal(result.status, 0, `workspace-root phase failed: ${result.stderr}`);
    return result.stdout;
  };

  const exists = async target => {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  };

  const makeWorkspace = async name => {
    const workspace = path.join(directory, name);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, '.cf-workspace.toml'), '[sources."demo"]\npath = "demo"\n');
    return workspace;
  };

  // A root we initialized ourselves, exactly as earlier images left it.
  const makeSyntheticRoot = async (workspace, { marker }) => {
    git(workspace, 'init', '-b', 'main');
    git(workspace, 'config', 'user.email', 'studio@example.invalid');
    git(workspace, 'config', 'user.name', 'Constructor Studio');
    await writeFile(path.join(workspace, 'README.md'), '# Workspace\n');
    git(workspace, 'add', 'README.md', '.cf-workspace.toml');
    git(workspace, 'commit', '-m', 'Initialize workspace', '--no-verify');
    if (marker) {
      await writeFile(path.join(workspace, '.git', 'cf-studio-managed-root'), '');
    }
  };

  // ── A container root stays a container ──
  {
    const workspace = await makeWorkspace('fresh');
    run(workspace, { STUDIO_MANAGED_WORKSPACE: '1' });
    assert.equal(
      await exists(path.join(workspace, '.git')),
      false,
      'a managed workspace root must not be turned into a git repository',
    );
    assert.equal(
      await exists(path.join(workspace, 'README.md')),
      false,
      'no placeholder README belongs in a workspace the project fills in',
    );
  }

  // ── A synthetic root from an earlier image is retired, not deleted ──
  for (const marker of [true, false]) {
    const workspace = await makeWorkspace(marker ? 'legacy-marked' : 'legacy-unmarked');
    await makeSyntheticRoot(workspace, { marker });
    run(workspace, { STUDIO_MANAGED_WORKSPACE: '1' });
    assert.equal(
      await exists(path.join(workspace, '.git')),
      false,
      `a synthetic root (${marker ? 'marked' : 'recognised by its shape'}) must stop being a repository`,
    );
    assert.ok(
      await exists(path.join(workspace, '.cf-studio', 'retired-root.git')),
      'the retired repository must remain recoverable',
    );
    assert.ok(
      await exists(path.join(workspace, '.cf-workspace.toml')),
      'retiring the repository must not disturb the working tree',
    );
  }

  // ── A repository a person owns is never moved ──
  {
    const workspace = await makeWorkspace('adopted');
    await makeSyntheticRoot(workspace, { marker: false });
    git(workspace, 'remote', 'add', 'origin', 'https://example.invalid/project.git');
    run(workspace, { STUDIO_MANAGED_WORKSPACE: '1' });
    assert.ok(
      await exists(path.join(workspace, '.git')),
      'a root with a remote is a real repository and must be left alone',
    );
  }

  // ── Nothing anywhere creates a repository at the root ──
  assert.doesNotMatch(
    block,
    /git -C "\$WORKSPACE" init/,
    'the workspace root must never be git-initialized: that is the phantom repository',
  );

  await rm(directory, { recursive: true, force: true });
  console.log('workspace root: ok');
}
