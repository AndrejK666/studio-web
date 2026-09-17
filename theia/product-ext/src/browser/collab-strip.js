/*
 * One line above the documents: what changed while you were reading.
 *
 * WHY IT EXISTS. `collab-view.js` answers the same questions at length, and
 * answering them at length is not the problem — a tab is somewhere you GO, and
 * every fact here is about work happening while you are looking at something
 * else. A colleague editing the next file, a thread that now mentions you: a
 * surface you have to remember to open tells you about those late or not at all.
 *
 * WHY ONE LINE, AND NOT THE WHOLE PANEL. Measured in the running IDE rather
 * than assumed. Theia's top panel is a 32px flex ROW shared with the menu bar,
 * and its height is set by the shell's own box layout:
 *
 *     #theia-top-panel  position: absolute; display: flex; height: 32px
 *       .theia-icon     32px
 *       .lm-MenuBar     368px
 *       <this>          the rest of the width
 *
 * A path, a quote, an author and an age do not fit in 32px any more than they
 * fit in a 257px rail, and making the row taller means fighting Lumino's
 * geometry, which is absolute and recomputed on every resize. So the row gets
 * what a row is good at — a line of facts, in the same idiom the status line
 * uses at the other edge of the window — and clicking it opens the page.
 *
 * WHAT IT COSTS WHEN THERE IS NOTHING TO SAY. The row is on screen for the menu
 * bar whatever this does, so the strip adds no height at all. It does add one
 * heartbeat and a debounced read of `.studio/comments` on file changes, which is
 * three directory walks and one read per commented document — the same work the
 * page does, and the reason it is debounced rather than polled.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. Numbers, not names, past one person: three
 * names in a 32px row is a smear. And nothing about unsaved work — a draft that
 * has not been written is not on disk, so "editing" reports presence, never
 * content.
 */

const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { URI } = require('@theia/core/lib/common/uri');
const { activeProject } = require('./active-project');
const { esc, avatarHtml } = require('./comment-ui');
const { identity } = require('./identity');
const { collab } = require('./collab-client');
const { CommentLog } = require('./comment-log');
const { ChangesStore } = require('./changes-store');
const sidecarScan = require('./sidecar-scan');
const scan = require('./collab-scan');

const COLLAB_STRIP_ID = 'studio-collaboration-strip';

/* The command the strip opens. A literal rather than an import, because
 * `product-frontend-module.js` requires this file and importing back would be a
 * cycle. */
const COLLAB_COMMAND_ID = 'studio.collaboration';

/* Slower than the page's, and than the heartbeat behind it: this line is read
 * in passing, and one that changes under the eye is one people stop reading. */
const ROSTER_POLL_MS = 8000;
const RESCAN_DEBOUNCE_MS = 600;

/* The fold is bounded the same way the page bounds it. A project with more
 * commented documents than this gets a number that is low rather than absent,
 * and the page says so where there is room to. */
const MAX_DOCUMENTS = 400;

class CollaborationStrip extends Widget {

    constructor(ctx) {
        super();
        this.workspaceService = ctx.workspaceService;
        this.fileService = ctx.fileService;
        this.commandRegistry = ctx.commandRegistry;
        this.commentLog = new CommentLog(ctx.fileService, ctx.workspaceService);
        this.changesStore = new ChangesStore(ctx.fileService, ctx.workspaceService);

        this.roster = { people: [], anonymous: 0 };
        this.result = { items: [], mentions: 0, waiting: 0, open: 0 };
        this.pending = 0;
        this.token = undefined;
        this.disposables = [];

        this.id = COLLAB_STRIP_ID;
        this.addClass('studio-collab-strip');

        /* A button, because it is one: the whole line opens the page. Built
         * once and only its contents replaced, so the click target does not
         * move under a pointer on every repaint. */
        this.node.innerHTML =
            '<button class="studio-collab-strip-btn" type="button" data-collab-open ' +
            'title="Open the collaboration page" aria-label="Open the collaboration page">' +
            '<span class="studio-collab-strip-line" data-collab-line aria-live="polite"></span>' +
            '</button>';
        this.lineEl = this.node.querySelector('[data-collab-line]');
        this.node.querySelector('[data-collab-open]').addEventListener('click', () => {
            if (this.commandRegistry) {
                this.commandRegistry.executeCommand(COLLAB_COMMAND_ID);
            }
        });
    }

    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.start();
        void this.refresh();
    }

    onCloseRequest(msg) {
        this.stop();
        super.onCloseRequest(msg);
        this.dispose();
    }

    start() {
        if (this.rosterTimer) { return; }
        this.rosterTimer = setInterval(() => void this.refreshRoster(), ROSTER_POLL_MS);
        if (this.fileService && this.fileService.onDidFilesChange) {
            this.disposables.push(this.fileService.onDidFilesChange(() => {
                clearTimeout(this.rescanTimer);
                this.rescanTimer = setTimeout(() => void this.refresh(), RESCAN_DEBOUNCE_MS);
            }));
        }
        this.disposables.push(activeProject.onChanged(() => void this.refresh()));
    }

    stop() {
        clearInterval(this.rosterTimer);
        this.rosterTimer = undefined;
        clearTimeout(this.rescanTimer);
        if (this.token) { this.token.cancelled = true; }
        for (const d of this.disposables) { try { d.dispose(); } catch (e) { /* already gone */ } }
        this.disposables = [];
    }

    async activeRoot() {
        let roots = [];
        try { roots = await this.workspaceService.roots; } catch (e) { roots = []; }
        const active = activeProject.resolve(roots);
        return active ? active.resource : undefined;
    }

    /** The cheap half: one call, no filesystem. */
    async refreshRoster() {
        const root = await this.activeRoot();
        if (!root) { return; }
        this.roster = scan.roster(await collab.everyone(root));
        this.render();
    }

    async refresh() {
        if (this.isDisposed) { return; }
        if (this.token) { this.token.cancelled = true; }
        const token = { cancelled: false };
        this.token = token;

        const root = await this.activeRoot();
        if (!root) {
            this.roster = { people: [], anonymous: 0 };
            this.result = { items: [], mentions: 0, waiting: 0, open: 0 };
            this.pending = 0;
            this.render();
            return;
        }

        this.roster = scan.roster(await collab.everyone(root));
        if (token.cancelled) { return; }

        const rootString = root.toString();
        const files = [];
        try {
            const sidecars = await sidecarScan.collectSidecars(this.fileService, root, token);
            for (const rel of [...sidecars.comments].slice(0, MAX_DOCUMENTS)) {
                if (token.cancelled) { return; }
                const uri = new URI(rootString + '/' + rel);
                try {
                    const store = await this.commentLog.load(uri);
                    files.push({ path: rel, uri: uri.toString(), threads: store.threads });
                } catch (e) { /* one unreadable sidecar is not the project */ }
            }
        } catch (e) { /* no sidecars is the common case, not an error */ }
        if (token.cancelled) { return; }

        this.result = scan.inbox(files, identity.current());
        try {
            const status = await this.changesStore.pendingFilesStatus(root);
            this.pending = status.available
                ? status.files.reduce((total, file) => total + file.pending, 0)
                : 0;
        } catch (e) {
            this.pending = 0;
        }
        if (token.cancelled) { return; }
        this.render();
    }

    render() {
        if (this.isDisposed) { return; }
        this.lineEl.innerHTML = this.lineHtml();
    }

    /*
     * The line, in the order somebody scans it: who, then what is waiting on
     * them, then what is waiting generally. Each part is omitted when it has
     * nothing to say, so a quiet project shows a quiet line rather than three
     * zeroes — the rule the status line's pending field already follows.
     */
    lineHtml() {
        const parts = [];
        const people = this.roster.people;
        if (people.length === 1) {
            parts.push('<span class="studio-collab-strip-who">' + avatarHtml(people[0].author) +
                esc((people[0].author.name || 'Somebody') +
                    (people[0].typing ? ' is editing' : ' is here')) + '</span>');
        } else if (people.length > 1) {
            const typing = people.filter(person => person.typing).length;
            parts.push('<span class="studio-collab-strip-who">' +
                people.slice(0, 4).map(person => avatarHtml(person.author)).join('') +
                esc(people.length + ' others here' + (typing ? ', ' + typing + ' editing' : '')) +
                '</span>');
        }
        if (this.result.mentions) {
            parts.push('<b class="studio-collab-strip-flag">' + this.result.mentions +
                ' mentioning you</b>');
        }
        if (this.result.waiting) {
            parts.push('<b class="studio-collab-strip-flag">' + this.result.waiting +
                ' waiting on you</b>');
        }
        if (this.result.open) {
            parts.push(esc(this.result.open + ' open ' +
                (this.result.open === 1 ? 'thread' : 'threads')));
        }
        if (this.pending) {
            parts.push(esc(this.pending + ' pending ' +
                (this.pending === 1 ? 'change' : 'changes')));
        }
        if (parts.length === 0) {
            // Not blank: the line is the only thing that says this surface
            // exists, and a strip nobody can see is a strip nobody opens.
            return '<span class="studio-collab-strip-idle">Collaboration</span>';
        }
        return parts.join('<span class="studio-collab-strip-sep">·</span>');
    }
}

const COLLAB_STRIP_CSS = `
/* --- the line above the documents ------------------------------------------ *
 *
 * It lives in the 32px row the menu bar is already in (see the header), so it
 * adds no height: what it must do is stay out of the menu bar's way and out of
 * the reader's. Right-aligned, 11px, the status line's own size — this and that
 * are one language at the two edges of the window.
 *
 * The whole line is the button. A 32px row has no space for a separate control,
 * and "click the words" is what a person tries first anyway. */
/* The flex rule is what makes "right-aligned" true rather than intended: the
   top panel is a flex ROW, so without it the widget is only as wide as its own
   text and sits hard against the menu bar. Measured in the running IDE — 88px
   and butted up to the menu without it, 1171px and at the window's edge with
   it, which is the status line's own position at the other edge. */
#theia-top-panel > .studio-collab-strip { flex: 1 1 auto; min-width: 0; }
.studio-collab-strip { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }
.studio-collab-strip-btn {
  display: flex; align-items: center; min-width: 0; max-width: 100%;
  height: 22px; padding: 0 8px; margin-right: 6px;
  border: 0; border-radius: 5px; background: transparent;
  color: var(--studio-text); font: inherit; font-size: 11px; cursor: pointer;
}
.studio-collab-strip-btn:hover { background: var(--studio-surface-raised); }
.studio-collab-strip-line {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.studio-collab-strip-who { display: flex; align-items: center; gap: 4px; min-width: 0; }
/* The avatars are the comment rail's own discs, shrunk to the row. Reused
   rather than redrawn so "who" looks the same wherever it is said. */
.studio-collab-strip .studio-avatar { width: 16px; height: 16px; font-size: 9px; flex: none; }
/* The two things addressed at this person are the only ones that carry the
   accent. Everything else on the line is a count, and a line where everything
   shouts says nothing. */
.studio-collab-strip-flag { color: var(--studio-accent); font-weight: 650; }
.studio-collab-strip-sep { color: var(--studio-muted); }
.studio-collab-strip-idle { color: var(--studio-muted); }
`;

module.exports = { CollaborationStrip, COLLAB_STRIP_CSS, COLLAB_STRIP_ID };
