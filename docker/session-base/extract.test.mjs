// The session-base layer copies its parts out of the Theia entrypoint; this
// holds the markers it reads in place, so a reshuffled entrypoint fails here
// rather than in an image build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fragments } from './extract.mjs';

const entrypoint = readFileSync(new URL('../../theia/docker/entrypoint.sh', import.meta.url), 'utf8');

test('every session-base fragment is in the Theia entrypoint', () => {
    const out = fragments(entrypoint);
    assert.deepEqual(Object.keys(out).sort(), [
        'clone-sources.sh', 'gate.js', 'git-config.sh', 'root-adoption.sh', 'splash.js', 'workspace-root.sh',
    ]);
    assert.match(out['gate.js'], /__studio_session_ready__/);
    assert.match(out['gate.js'], /\/internal\/ide\/v2\//);
    assert.match(out['splash.js'], /listen\(3003/);
    assert.match(out['git-config.sh'], /credential\.helper '!node \/usr\/local\/lib\/studio-git-credentials\.mjs'/);
    assert.match(out['clone-sources.sh'], /^clone_workspace_sources\(\) \{/m);
    assert.match(out['root-adoption.sh'], /STUDIO_ROOT_URL/);
    assert.match(out['workspace-root.sh'], /cf-studio-managed-root/);
});

test('a missing marker is an error, not an empty fragment', () => {
    assert.throws(() => fragments(entrypoint.replace('# <<< studio:root-adoption', '')), /root-adoption/);
});
