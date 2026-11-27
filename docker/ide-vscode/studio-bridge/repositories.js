'use strict';
// The repositories of a session's /workspace, as the control API lists them.
//
// Read off the disk rather than out of the editor: the control server answers
// whether or not anybody has the IDE open, and the checkout lands in
// /workspace behind the IDE, one directory per source.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function isRepository(dir) {
    try {
        return fs.existsSync(path.join(dir, '.git'));
    } catch {
        return false;
    }
}

function descriptor(dir, kind, gitMode) {
    const id = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16);
    return {
        repositoryId: `repo-${id}`,
        fingerprint: id,
        rootUri: `file://${dir}`,
        label: path.basename(dir),
        gitMode,
        kind,
    };
}

/**
 * The root, when it is a repository (`project`), then each directory directly
 * below it that is one (`source`), by name. Hidden directories are skipped,
 * except `.workspace-sources/*`, where a CLI workspace keeps its sources.
 */
function listRepositories(root, gitMode = 'disabled') {
    const out = [];
    if (isRepository(root)) {
        out.push(descriptor(root, 'project', gitMode));
    }
    const children = (dir) => {
        try {
            return fs.readdirSync(dir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => e.name)
                .sort();
        } catch {
            return [];
        }
    };
    for (const name of children(root)) {
        if (name.startsWith('.')) {
            continue;
        }
        const dir = path.join(root, name);
        if (isRepository(dir)) {
            out.push(descriptor(dir, 'source', gitMode));
        }
    }
    const nested = path.join(root, '.workspace-sources');
    for (const name of children(nested)) {
        const dir = path.join(nested, name);
        if (isRepository(dir)) {
            out.push(descriptor(dir, 'source', gitMode));
        }
    }
    return out;
}

/**
 * Where a workspace-relative path is: under the root, else one level below
 * each root directory (`<checkout>/<path in the repository>` and the path in
 * the repository alone both work, as in Theia). `undefined` for a path that
 * leaves the workspace or that is not there.
 */
function resolveWorkspacePath(root, relativePath) {
    const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.split('/').includes('..')) {
        return undefined;
    }
    const inside = (candidate) => {
        const resolved = path.resolve(candidate);
        return resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    };
    const direct = path.join(root, rel);
    if (inside(direct) && fs.existsSync(direct)) {
        return direct;
    }
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
    } catch {
        return undefined;
    }
    for (const name of entries) {
        const candidate = path.join(root, name, rel);
        if (inside(candidate) && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

module.exports = { listRepositories, resolveWorkspacePath };
