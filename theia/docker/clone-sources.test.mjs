// The workspace-source clone phase of the session entrypoint.
//
// This phase is where startup time is won or lost, and it had no coverage at
// all. Four things are asserted here, each one something that broke or could
// break silently: field parsing (a source with no branch must not shift the
// next field into `--branch`), cloning through Studio's Git proxy (`clone_url`
// is what is cloned and what `origin` points at; an older checkout is
// repointed there, #1095), concurrency (sources are independent directories, so the
// phase must cost the slowest repository rather than the sum), and its place
// in the boot order — the phase runs BEHIND the IDE, and a change that quietly
// put it back in front would restore the wait it exists to avoid.
//
// Like gate.test.mjs, the code under test is extracted from entrypoint.sh
// rather than copied, so this cannot drift away from what ships.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  console.log('workspace source clones: skipped (no bash on PATH)');
} else {
  const entrypoint = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
  const match = entrypoint.match(/^# >>> studio:clone-sources$([\s\S]*?)^# <<< studio:clone-sources$/m);
  assert.ok(match, 'entrypoint must delimit the clone phase with the studio:clone-sources markers');
  const block = match[1];
  assert.match(block, /STUDIO_SOURCES/, 'extracted block must include the sources loop');
  assert.match(block, /STUDIO_CLONE_JOBS/, 'extracted block must include the concurrency cap');

  // ── Boot order ──
  // The phase is a function precisely so the session does not wait for it: the
  // gate takes the port first, the clones are backgrounded, and the IDE starts
  // over a workspace they are still filling in. A document needs none of them.
  const gateAt = entrypoint.indexOf('\nnode /tmp/gate.js &');
  const cloneAt = entrypoint.indexOf('\nclone_workspace_sources &');
  const execAt = entrypoint.indexOf('\nexec npm');
  assert.ok(gateAt > 0, 'entrypoint must start the session gate');
  assert.ok(cloneAt > gateAt, 'sources must be cloned after the gate owns the port');
  assert.ok(execAt > cloneAt, 'the IDE must start after the clone phase is backgrounded');
  assert.doesNotMatch(
    entrypoint,
    /^clone_workspace_sources$/m,
    'the clone phase must never be called in the foreground',
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-clone-test-'));
  const script = path.join(directory, 'clone-block.sh');
  await writeFile(script, `#!/bin/bash\nset -euo pipefail\nWORKSPACE="$1"\nshift\n${block}\nclone_workspace_sources\n`, 'utf8');

  const git = (args, cwd) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const runBlock = (workspace, env = {}) =>
    spawnSync('bash', [script, workspace], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  try {
    // ── Upstream repositories to clone from ──
    const upstream = path.join(directory, 'upstream');
    for (const name of ['a', 'b', 'c', 'd']) {
      const repo = path.join(upstream, name);
      await mkdir(repo, { recursive: true });
      git(['init', '-q', '.'], repo);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
    }
    const withBranch = path.join(upstream, 'd');
    git(['checkout', '-q', '-b', 'feature'], withBranch);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'feature'], withBranch);

    const workspace = path.join(directory, 'ws');
    await mkdir(path.join(workspace, 'already'), { recursive: true });
    await writeFile(path.join(workspace, 'already', 'file.txt'), 'keep', 'utf8');

    // An earlier session's checkout of `e`, made straight from the source
    // host: its origin is the repository's own address.
    const hostAddress = path.join(upstream, 'c');
    git(['clone', '-q', hostAddress, path.join(workspace, 'e')], directory);

    // Through the proxy, `clone_url` is cloned and `url` is only the
    // repository's identity. Here the "proxy" is another local repository,
    // and `url` names one that does not exist, so a clone of `url` would fail.
    const nowhere = path.join(upstream, 'not-the-clone-source');
    const sources = [
      { name: 'a', url: path.join(upstream, 'a') },
      // The regression: a clone URL with no branch. `branch` is empty, and a
      // tab separator would collapse it and shift the clone URL into its place.
      { name: 'b', url: nowhere, clone_url: path.join(upstream, 'b') },
      { name: 'c', url: path.join(upstream, 'c') },
      { name: 'd', url: nowhere, clone_url: withBranch, branch: 'feature' },
      { name: 'e', url: hostAddress, clone_url: path.join(upstream, 'a') },
      { name: 'already', url: path.join(upstream, 'a') },
      { name: 'broken', url: path.join(upstream, 'does-not-exist') },
    ];

    const run = runBlock(workspace, { STUDIO_SOURCES: JSON.stringify(sources) });
    const output = `${run.stdout}${run.stderr}`;

    // A failing source must not abort the session: the entrypoint runs under
    // `set -e`, and the IDE has to start with whatever did materialize.
    assert.equal(run.status, 0, `clone block exited ${run.status}: ${output}`);

    for (const name of ['a', 'b', 'c', 'd']) {
      const head = spawnSync('git', ['-C', path.join(workspace, name), 'branch', '--show-current'], {
        encoding: 'utf8',
      });
      assert.equal(head.status, 0, `source '${name}' was not cloned: ${output}`);
      if (name === 'd') {
        assert.equal(head.stdout.trim(), 'feature', "source 'd' must be on its requested branch");
      }
    }

    assert.match(output, /source 'already' already materialized/);
    assert.match(output, /WARNING: clone of 'broken' failed/);
    assert.equal(
      git(['remote', 'get-url', 'origin'], path.join(workspace, 'b')),
      path.join(upstream, 'b'),
      'a proxied source is cloned from, and fetches and pushes through, its clone_url',
    );
    assert.equal(
      git(['remote', 'get-url', 'origin'], path.join(workspace, 'e')),
      path.join(upstream, 'a'),
      "an older checkout's origin moves from the source host to the proxy",
    );
    assert.match(output, /source 'e' already materialized — origin now goes through Studio/);
    const config = await readFile(path.join(workspace, 'b', '.git', 'config'), 'utf8');
    assert.doesNotMatch(config, /password|token/i, 'no credential lands in .git/config');

    // ── Concurrency ──
    // Four stubbed clones of two seconds each: sequentially that is eight
    // seconds, so anything under five proves they overlap. The stub replaces
    // git on PATH rather than slowing a real clone, which keeps the assertion
    // about the loop instead of about network speed.
    const stubBin = path.join(directory, 'stub-bin');
    await mkdir(stubBin, { recursive: true });
    await writeFile(
      path.join(stubBin, 'git'),
      '#!/bin/bash\ndest="${@: -1}"\nsleep 2\nmkdir -p "$dest/.git"\n',
      { encoding: 'utf8', mode: 0o755 },
    );
    const parallelWorkspace = path.join(directory, 'ws-parallel');
    await mkdir(parallelWorkspace, { recursive: true });
    const started = Date.now();
    const parallel = runBlock(parallelWorkspace, {
      PATH: `${stubBin}${path.delimiter}${process.env.PATH}`,
      STUDIO_SOURCES: JSON.stringify(
        ['p', 'q', 'r', 's'].map((name) => ({ name, url: path.join(upstream, 'a') })),
      ),
      STUDIO_CLONE_JOBS: '4',
    });
    const elapsed = Date.now() - started;
    assert.equal(parallel.status, 0, `parallel run exited ${parallel.status}`);
    assert.ok(
      elapsed < 5000,
      `four 2s clones took ${elapsed}ms — they are running sequentially`,
    );

    console.log('workspace source clones parse every field and run concurrently');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
