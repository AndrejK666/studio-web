/*
 * Which documents in a project have comments, proposals or history.
 *
 * WHY IT IS A WALK AND NOT A PROBE. The sidecars mirror the document tree —
 * `.studio/comments/docs/prd.md/` beside `docs/prd.md` — so "does this file
 * have comments" looks like a question you ask per file. On a project with
 * 1,200 documents and comments on nine of them, asking it three times per file
 * costs 3,600 filesystem calls to discover nine. Three directory walks cost
 * three. That arithmetic is from `search-view.js`, which is where this code was
 * written and where it ran first.
 *
 * WHY IT IS ITS OWN MODULE NOW. Search was the only thing that needed to know
 * where collaboration lives on disk. The collaboration tab needs exactly the
 * same answer, and the layout it depends on is subtle enough that two copies
 * would drift: a comment log is a DIRECTORY of per-author `.jsonl` files
 * (comment-log.js), the legacy sidecar beside it is a single `.json` FILE
 * (comments-store.js), both name one document, and `changes/index.json` is the
 * project-wide pending index rather than any document's proposals. Every one of
 * those is a rule somebody would get wrong writing it a second time from
 * memory.
 *
 * The file service is a parameter rather than a constructor dependency, so this
 * module needs no widget, no container and no DOM — it is the walk, and nothing
 * else.
 */

const { URI } = require('@theia/core/lib/common/uri');

/** A uri as a path relative to a root, or unchanged when it is not under it. */
function relativeTo(rootString, uriString) {
    return uriString.startsWith(rootString) ? uriString.slice(rootString.length).replace(/^\//, '') : uriString;
}

/**
 * Walk one sidecar tree, calling `visit(rel, isDirectory, hasLogs)` per entry.
 *
 * `token.cancelled` is checked between entries so a long walk stops when the
 * surface that asked for it has moved on.
 */
async function walkSidecar(fileService, dirUri, prefix, token, visit) {
    if (token.cancelled) { return; }
    let stat;
    try {
        // A project with no comments has no .studio/comments, and that is
        // the common case rather than an error.
        if (!(await fileService.exists(dirUri))) { return; }
        stat = await fileService.resolve(dirUri);
    } catch (e) {
        return;
    }
    for (const child of (stat && stat.children) || []) {
        if (token.cancelled) { return; }
        const rel = relativeTo(prefix, child.resource.toString());
        if (child.isDirectory) {
            /* A log directory is one whose own children are .jsonl files.
             * Anything else is an intermediate folder mirroring the
             * document tree, so the walk continues through it. */
            let logs = false;
            try {
                const inner = await fileService.resolve(child.resource);
                logs = ((inner && inner.children) || []).some(entry =>
                    !entry.isDirectory && entry.resource.path.base.endsWith('.jsonl'));
            } catch (e) { /* treated as not a log directory */ }
            visit(rel, true, logs);
            if (!logs) { await walkSidecar(fileService, child.resource, prefix, token, visit); }
            continue;
        }
        visit(rel, false, false);
    }
}

/**
 * The three sets, for one connected root: which documents have comment logs,
 * which have proposals, and which have history. Paths are relative to the root.
 */
async function collectSidecars(fileService, rootUri, token) {
    const found = { comments: new Set(), changes: new Set(), history: new Set() };
    const base = rootUri.toString() + '/.studio';

    /* comments/<rel>/  is a DIRECTORY of per-author .jsonl logs;
     * comments/<rel>.json is the legacy sidecar. Both name one document. */
    await walkSidecar(fileService, new URI(base + '/comments'), base + '/comments', token, (rel, isDirectory, hasLogs) => {
        if (isDirectory && hasLogs) { found.comments.add(rel); }
        if (!isDirectory && rel.endsWith('.json')) { found.comments.add(rel.slice(0, -'.json'.length)); }
    });
    await walkSidecar(fileService, new URI(base + '/changes'), base + '/changes', token, (rel, isDirectory) => {
        // index.json at the top is the workspace-wide pending index, not a
        // document's proposals.
        if (!isDirectory && rel.endsWith('.json') && rel !== 'index.json') { found.changes.add(rel.slice(0, -'.json'.length)); }
    });
    await walkSidecar(fileService, new URI(base + '/history'), base + '/history', token, (rel, isDirectory) => {
        if (!isDirectory && rel.endsWith('.json')) { found.history.add(rel.slice(0, -'.json'.length)); }
    });
    return found;
}

module.exports = { walkSidecar, collectSidecars, relativeTo };
