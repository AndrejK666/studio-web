/*
 * A start page per mode: the registry, and what the empty dock decides.
 *
 * No DOM, no Theia, nothing that needs a window -- tested in node
 * (test/start-pages.test.js). welcome-view.js owns the layer, the reads and the
 * paint.
 *
 * WHY A REGISTRY, AND WHY ON globalThis. The empty main dock is one layer
 * (welcome-view.js) and Doc editing's page is product-ext's own. The other modes'
 * pages need what only their own packages hold: Development and Agent
 * development read git and Orca through `theia/studio`, Building reads the
 * products and the catalogue through `theia/gearbox-studio`. Those packages do
 * not import product-ext, and product-ext imports neither -- they share no code
 * at all. So they meet on a plain object under a well-known symbol, which
 * whichever side runs first creates:
 *
 *   const hub = globalThis[Symbol.for('studio.start-pages.v1')]
 *       ??= { pages: [], sections: [], listeners: [] };
 *   hub.pages.push(page); hub.listeners.forEach(fn => fn());
 *
 * That is the whole protocol, and a contributor that cannot import this file
 * writes those two lines (theia/studio/src/browser/start-page-hub.ts,
 * theia/gearbox-studio/src/browser/start/start-page-hub.ts).
 *
 * WHAT A PAGE IS. Data, not markup, so every page looks like the Doc editing
 * page without copying its CSS:
 *
 *   {
 *     id, modes: ['<perspective id>', ...], label, summary,
 *     actions: [Action],                        // drawn at once, before the read
 *     load(ctx) -> Promise<{ sections: [Section], actions?: [Action], foot? }>,
 *     watch?(reload) -> { dispose() },          // optional: when to read again
 *   }
 *   Action  = { id?, label, title?, command?, args?, activate?(), enabled?, reason?, kbd? }
 *   Section = { id, title, count?, column?, rows: [Row], empty?, note?, more? }
 *   Row     = { name, detail?, folder?, meta?, tag?, title?, open?: uri,
 *               command?, args?, activate?(), enabled?, reason? }
 *
 * `ctx` is `{ token, root, rootString, projectName, section(id) }`: a newer read
 * cancels an older one through `token.cancelled`, and `section(id)` borrows a
 * section another package registered (`{ id, title, load(ctx) }`) -- Full
 * functionality lists the recent documents product-ext reads and the
 * repositories studio reads, without either knowing the other.
 *
 * WHAT A BUTTON MAY BE. Only a command that exists, and only drawn enabled when
 * the command says it is; otherwise it says why, the way the ribbon does
 * (studio-mode-bar.tsx `ribbonAction`, whose rules `actionState` repeats).
 */

const HUB_KEY = Symbol.for('studio.start-pages.v1');

/* A glance, not a list: the views the rows open are where the whole list lives. */
const ROWS_MAX = 6;
/* The head's buttons. More than four stop being a choice. */
const ACTIONS_MAX = 4;

/** The shared registry, created by whichever package touches it first. */
function startPageHub(scope = globalThis) {
    let hub = scope[HUB_KEY];
    if (!hub || typeof hub !== 'object') {
        hub = { pages: [], sections: [], listeners: [] };
        scope[HUB_KEY] = hub;
    }
    hub.pages = Array.isArray(hub.pages) ? hub.pages : [];
    hub.sections = Array.isArray(hub.sections) ? hub.sections : [];
    hub.listeners = Array.isArray(hub.listeners) ? hub.listeners : [];
    return hub;
}

function notify(hub) {
    for (const listener of hub.listeners.slice()) {
        try { listener(); } catch (e) { /* one listener's failure is not the registry's */ }
    }
}

function add(list, item, hub) {
    list.push(item);
    notify(hub);
    return {
        dispose() {
            const at = list.indexOf(item);
            if (at >= 0) { list.splice(at, 1); notify(hub); }
        }
    };
}

function registerStartPage(page, scope) {
    const hub = startPageHub(scope);
    return add(hub.pages, page, hub);
}

function registerStartSection(section, scope) {
    const hub = startPageHub(scope);
    return add(hub.sections, section, hub);
}

function onStartPagesChanged(listener, scope) {
    const hub = startPageHub(scope);
    hub.listeners.push(listener);
    return {
        dispose() {
            const at = hub.listeners.indexOf(listener);
            if (at >= 0) { hub.listeners.splice(at, 1); }
        }
    };
}

/*
 * Doc editing's page -- recent documents, threads, proposals -- is product-ext's
 * own, and also what a build with no modes shows (no `data-studio-perspective`
 * on the body). See welcome-scan.js startPageShownIn.
 */
const DOCUMENTS_PAGE = 'documents';

/**
 * Which page the empty dock shows in `mode`: `'documents'`, a registered page,
 * or `undefined` for a mode nobody drew a page for (the dock stays empty, as it
 * did). The last page registered for a mode wins, so a build can replace one.
 */
function pageForMode(mode, pages, documentsShownIn) {
    if (documentsShownIn(mode)) { return DOCUMENTS_PAGE; }
    const matching = (pages || []).filter(page =>
        page && typeof page.load === 'function' && Array.isArray(page.modes) && page.modes.includes(mode));
    return matching.length ? matching[matching.length - 1] : undefined;
}

/**
 * Whether, and how, an action is drawn: `undefined` when it is not drawn at all,
 * else `{ enabled, title }`.
 *
 * The ribbon's rules. A command that is not registered -- its package absent
 * from this build, a plugin not installed -- is left out rather than drawn as a
 * button that does nothing. One that exists but is not enabled now is drawn
 * disabled and says why when its handler can (`disabledReason(...args)`). A page
 * may add its own reason (`enabled: false, reason`) for what the command cannot
 * know, and an action with `activate` instead of a command is the page's own and
 * as enabled as the page says.
 */
function actionState(commands, action) {
    if (!action) { return undefined; }
    const title = String(action.title || action.label || '');
    const own = action.enabled === false
        ? { enabled: false, title: title + ' — ' + (action.reason || 'not available right now') }
        : undefined;
    if (typeof action.activate === 'function') {
        return own || { enabled: true, title };
    }
    if (!action.command || !commands || typeof commands.getCommand !== 'function' || !commands.getCommand(action.command)) {
        return undefined;
    }
    if (own) { return own; }
    const args = Array.isArray(action.args) ? action.args : [];
    let enabled = false;
    try { enabled = !!commands.isEnabled(action.command, ...args); } catch (e) { enabled = false; }
    if (enabled) { return { enabled: true, title }; }
    let reason;
    let handlers = [];
    try { handlers = typeof commands.getAllHandlers === 'function' ? commands.getAllHandlers(action.command) : []; } catch (e) { handlers = []; }
    for (const handler of handlers || []) {
        const explain = handler && handler.disabledReason;
        if (typeof explain !== 'function') { continue; }
        let said;
        try { said = explain.apply(handler, args); } catch (e) { said = undefined; }
        if (typeof said === 'string' && said.trim()) { reason = said.trim(); break; }
    }
    return { enabled: false, title: title + ' — ' + (reason || 'not available right now') };
}

/** The head's buttons: the ones this build can draw, in the page's order, at most four. */
function visibleActions(commands, actions, max = ACTIONS_MAX) {
    const out = [];
    for (const action of actions || []) {
        const state = actionState(commands, action);
        if (!state) { continue; }
        out.push({ action, state });
        if (out.length >= max) { break; }
    }
    return out;
}

/** What a click on a row does, and whether it can: a row with nothing to do is text. */
function rowState(commands, row) {
    if (!row) { return { kind: 'none' }; }
    const own = row.enabled !== false;
    const ownTitle = own ? (row.title || '') : [row.title || row.name, row.reason || 'not available right now'].filter(Boolean).join(' — ');
    if (typeof row.activate === 'function') { return { kind: 'activate', enabled: own, title: ownTitle }; }
    if (row.open) { return { kind: 'open', enabled: own, title: ownTitle }; }
    if (row.command) {
        const state = actionState(commands, { command: row.command, args: row.args, title: row.title || row.name, enabled: row.enabled, reason: row.reason });
        if (!state) { return { kind: 'none' }; }
        return { kind: 'command', enabled: state.enabled, title: state.title };
    }
    return { kind: 'none' };
}

function text(value, max = 200) {
    if (value === undefined || value === null) { return ''; }
    const s = String(value).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * A section as drawn: strings clipped, rows capped with the rest counted, and a
 * section that says nothing at all dropped. Whatever a contributor returns, the
 * paint gets this shape.
 */
function sectionView(section, index = 0, max = ROWS_MAX) {
    if (!section || typeof section !== 'object') { return undefined; }
    const rows = (Array.isArray(section.rows) ? section.rows : []).filter(row => row && (row.name || row.detail));
    const title = text(section.title, 80);
    const empty = text(section.empty, 300);
    const note = text(section.note, 400);
    if (!title && !rows.length && !empty && !note) { return undefined; }
    const extra = Math.max(0, rows.length - max);
    return {
        id: text(section.id, 80) || 'section-' + index,
        title,
        count: text(section.count, 60),
        column: section.column === 1 || section.column === 0 ? section.column : index % 2,
        rows: rows.slice(0, max).map(row => Object.assign({}, row, {
            name: text(row.name, 160),
            detail: text(row.detail, 240),
            folder: text(row.folder, 240),
            meta: text(row.meta, 80),
            tag: text(row.tag, 60)
        })),
        more: (Number(section.more) || 0) + extra,
        moreAction: section.moreAction,
        empty,
        note
    };
}

/** The two columns of the grid; one column when everything is in one. */
function columnsOf(sections) {
    const views = (sections || []).map((section, index) => sectionView(section, index)).filter(Boolean);
    const left = views.filter(view => view.column === 0);
    const right = views.filter(view => view.column === 1);
    if (!left.length) { return [right]; }
    if (!right.length) { return [left]; }
    return [left, right];
}

/** A failed read, as a sentence rather than a stack. */
function failureText(error) {
    const said = error && (error.message || String(error));
    return text(said || 'unknown error', 200);
}

module.exports = {
    HUB_KEY, ROWS_MAX, ACTIONS_MAX, DOCUMENTS_PAGE,
    startPageHub, registerStartPage, registerStartSection, onStartPagesChanged,
    pageForMode, actionState, visibleActions, rowState, sectionView, columnsOf, failureText
};
