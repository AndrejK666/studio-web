#!/usr/bin/env node
// The session's IDE-neutral parts, taken from the one place they are written.
//
// The Theia image is built from `theia/` alone, so its entrypoint is where the
// splash, the gate, the git configuration and the checkout live
// (`theia/docker/entrypoint.sh`). This copies each of them out at build time
// into the session-base layer (ADR-0080 §3), so a second IDE's image runs the
// same code rather than a copy that drifts:
//
//   splash.js          the page that holds port 3003 while /workspace is prepared
//   gate.js            the session gate (cookie, readiness, control pass-through)
//   git-config.sh      git identity, safe.directory, the credential helper
//   clone-sources.sh   clone_workspace_sources, run behind the IDE
//   root-adoption.sh   adopt STUDIO_ROOT_URL into /workspace
//   workspace-root.sh  retire a synthetic root, mark a managed one
//
// Usage: node extract.mjs <entrypoint.sh> <out dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HEREDOCS = { 'splash.js': ['/tmp/splash.js', 'SPLASH'], 'gate.js': ['/tmp/gate.js', 'GATE'] };
const BLOCKS = ['git-config', 'clone-sources', 'root-adoption', 'workspace-root'];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Every fragment of `entrypoint`, by its file name. Throws on one that is missing. */
export function fragments(entrypoint) {
    const out = {};
    for (const [file, [target, tag]] of Object.entries(HEREDOCS)) {
        const pattern = new RegExp(`cat > ${escape(target)} <<'${tag}'\\r?\\n([\\s\\S]*?)\\r?\\n${tag}\\r?\\n`);
        const match = entrypoint.match(pattern);
        if (!match) throw new Error(`entrypoint has no ${target} heredoc`);
        out[file] = match[1] + '\n';
    }
    for (const name of BLOCKS) {
        const pattern = new RegExp(`# >>> studio:${name}\\r?\\n([\\s\\S]*?)\\r?\\n# <<< studio:${name}`);
        const match = entrypoint.match(pattern);
        if (!match) throw new Error(`entrypoint has no studio:${name} block`);
        out[`${name}.sh`] = match[1] + '\n';
    }
    return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const [source, outDir] = process.argv.slice(2);
    if (!source || !outDir) {
        console.error('usage: node extract.mjs <entrypoint.sh> <out dir>');
        process.exit(2);
    }
    mkdirSync(outDir, { recursive: true });
    for (const [file, text] of Object.entries(fragments(readFileSync(source, 'utf8')))) {
        writeFileSync(path.join(outDir, file), text);
    }
}
