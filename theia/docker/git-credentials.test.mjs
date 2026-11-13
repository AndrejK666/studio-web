// The session credential helper. What matters here is not that it answers,
// but that it refuses: it holds the session's credential to Studio's Git
// proxy, and a git process in a session is steered by repository config,
// submodules and, through Orca, by an agent acting on repository content.
// So every case below that expects an empty answer is the point of the
// test, and the "no token in the output" assertions guard the rest.
//
// No source host's key reaches a session any more (#1095): the helper has
// none to give, only the proxy credential, and only for the proxy addresses
// the workspace was cloned from.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./git-credentials.mjs', import.meta.url));

const PROXY_TOKEN = 'session-proxy-credential';
const PROXY = 'https://studio.example.com/cf/studio-git/v1/workspaces/0b0b/sources';
const SOURCES = JSON.stringify([
  { name: 'web', url: 'https://github.com/acme/studio-web', clone_url: `${PROXY}/web` },
  // Not cloned through the proxy (its connection is not the organization's,
  // or it is not the project's): no credential for it, anywhere.
  { name: 'docs', url: 'https://github.com/acme/docs' },
]);

const ask = (request, env = {}, action = 'get') => {
  const result = spawnSync(process.execPath, [helper, action], {
    input: `${Object.entries(request).map(([k, v]) => `${k}=${v}`).join('\n')}\n\n`,
    encoding: 'utf8',
    env: { STUDIO_SOURCES: SOURCES, STUDIO_GIT_PROXY_TOKEN: PROXY_TOKEN, ...env },
  });
  assert.equal(result.status, 0, `helper exited ${result.status}: ${result.stderr}`);
  const answer = {};
  for (const line of result.stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) answer[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return { answer, stdout: result.stdout };
};

const proxied = { protocol: 'https', host: 'studio.example.com', path: 'cf/studio-git/v1/workspaces/0b0b/sources/web' };

// ── The proxy address a source was cloned from gets the session credential ──
{
  const { answer } = ask(proxied);
  assert.equal(answer.password, PROXY_TOKEN);
  const withSuffix = ask({ ...proxied, path: `${proxied.path}.git` }).answer;
  assert.equal(withSuffix.password, PROXY_TOKEN, 'git may add .git to the path');
}

// ── Refusals ──
for (const [what, request, env] of [
  ['the source host itself', { protocol: 'https', host: 'github.com', path: 'acme/studio-web' }, {}],
  ['a source not cloned through the proxy', { protocol: 'https', host: 'github.com', path: 'acme/docs' }, {}],
  ['another source path on the proxy', { ...proxied, path: 'cf/studio-git/v1/workspaces/0b0b/sources/other' }, {}],
  ['another workspace on the proxy', { ...proxied, path: 'cf/studio-git/v1/workspaces/ffff/sources/web' }, {}],
  ['a lookalike host', { ...proxied, host: 'studio.example.com.evil.example.com' }, {}],
  ['plain http to an https proxy', { ...proxied, protocol: 'http' }, {}],
  ['a non-http protocol', { ...proxied, protocol: 'ssh' }, {}],
  ['no path (useHttpPath off)', { protocol: 'https', host: 'studio.example.com' }, {}],
  ['no host at all', { protocol: 'https' }, {}],
  ['no session credential', proxied, { STUDIO_GIT_PROXY_TOKEN: '' }],
  ['a malformed STUDIO_SOURCES', proxied, { STUDIO_SOURCES: '{not json' }],
  // What the old helper answered with: a personal or per-source host key.
  ['a leftover personal token', { protocol: 'https', host: 'github.com', path: 'acme/docs' },
    { STUDIO_GIT_PAT: 'personal-token', STUDIO_GIT_PROXY_TOKEN: '' }],
]) {
  const { stdout } = ask(request, env);
  assert.equal(stdout.trim(), '', `${what} must get no credentials`);
}

// ── Nothing is persisted, so store and erase have nothing to say ──
for (const action of ['store', 'erase']) {
  const { stdout } = ask({ ...proxied, username: 'studio-session', password: PROXY_TOKEN }, {}, action);
  assert.equal(stdout.trim(), '', `${action} must write nothing`);
}

// ── The shipping configuration, exercised through git itself ──
// A helper that returns the right answer is only half of it: git has to be
// configured to call it, and `credential.useHttpPath` has to be on or the
// path match above can never fire. Both lines are read out of entrypoint.sh,
// and the path they name is checked against the Dockerfile, so none of the
// three can drift apart silently.
{
  const entrypoint = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
  const useHttpPath = entrypoint.match(/^git config --global credential\.useHttpPath (\S+)$/m);
  const helperLine = entrypoint.match(/^git config --global credential\.helper '(.+)'$/m);
  assert.ok(useHttpPath, 'entrypoint must enable credential.useHttpPath');
  assert.equal(useHttpPath[1], 'true');
  assert.ok(helperLine, 'entrypoint must configure a credential helper');
  assert.doesNotMatch(entrypoint, /STUDIO_ROOT_TOKEN|STUDIO_GIT_PAT/, 'no source host key is read any more');

  const installedPath = helperLine[1].match(/(\/\S+\.mjs)/)?.[1];
  assert.ok(installedPath, 'the helper line must name the installed script');
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.ok(
    dockerfile.includes(`docker/git-credentials.mjs ${installedPath}`),
    `the image must install docker/git-credentials.mjs at ${installedPath}`,
  );

  // Run git with the entrypoint's own configuration, pointed at this
  // checkout's copy of the helper, and isolated from the developer's git
  // config: a machine-wide helper would otherwise answer first, or hang on
  // a GUI prompt, and this would be a test of that instead.
  const quotedHelper = `"${helper.split(path.sep).join('/')}"`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-credential-test-'));
  try {
    const emptyConfig = path.join(directory, 'empty.gitconfig');
    await writeFile(emptyConfig, '');
    const filled = spawnSync(
      'git',
      [
        '-c', `credential.useHttpPath=${useHttpPath[1]}`,
        // git runs a `!`-prefixed helper through a shell, which eats Windows
        // backslashes; the container path is POSIX already, so this only
        // matters for running the test on a Windows checkout.
        '-c', `credential.helper=${helperLine[1].replace(installedPath, quotedHelper)}`,
        'credential', 'fill',
      ],
      {
        input: [`url=${PROXY}/web.git`, '', ''].join('\n'),
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_SYSTEM: emptyConfig,
          GIT_TERMINAL_PROMPT: '0',
          STUDIO_SOURCES: SOURCES,
          STUDIO_GIT_PROXY_TOKEN: PROXY_TOKEN,
        },
      },
    );
    assert.equal(filled.status, 0, `git credential fill failed: ${filled.stderr}`);
    assert.match(
      filled.stdout,
      new RegExp(`password=${PROXY_TOKEN}`),
      'git must resolve the session credential through the configured helper',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

console.log('session credential helper answers for the proxy addresses only, and git uses it');
