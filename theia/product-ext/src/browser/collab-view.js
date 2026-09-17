/*
 * Collaboration — the project tab. Who is here, what is being discussed, and
 * what is waiting for a decision.
 *
 * WHY A MAIN-DOCK TAB AND NOT A PANEL. Same arithmetic as the Quality tab, and
 * the same reason: every fact on this page is about a PROJECT rather than about
 * the document somebody happens to have open. Opening `prd.md` tells you
 * nothing about the thread waiting on you in `architecture.md`, and a 257px
 * rail cannot hold a path, a quote, an author and an age on one line — measured
 * twice already in this product, by Search and by Quality.
 *
 * WHAT IT SHOWS, and why each part is here rather than somewhere that already
 * exists:
 *
 *   - HERE NOW. Who else is in this project and what they have open. This is
 *     the one fact the product could not state at all before presence existed:
 *     one session container serves everybody who opened the workspace, so the
 *     colleague editing the next file was invisible.
 *   - OPEN THREADS, ranked. A comment thread lives in the document it is
 *     anchored to, which is right for answering it and useless for finding it:
 *     a project with comments on nine of a thousand files gives a person no way
 *     to know which nine. The order is the product decision — mentions of you,
 *     then threads waiting on you, then everything else newest first — and it
 *     lives in `collab-scan.js` where it can be tested.
 *   - WAITING FOR REVIEW. Files holding pending proposals, from the index the
 *     status line already counts. The status line says HOW MANY; this says
 *     WHICH, which is the question that follows it and had no answer.
 *
 * WHAT IT DOES NOT SHOW, said in the UI as well as here:
 *
 *   - OTHER PEOPLE'S UNSAVED WORK. A draft that has not been written is not on
 *     disk and cannot be read. The roster reports "editing" from presence, so a
 *     person shows as busy without their words being claimed to be known.
 *   - COMMENTS MADE IN CONNECTED TOOLS. Figma, pull requests and chat are not
 *     in the repository. `honestyLine` says so on every render, because a quiet
 *     inbox that is quiet for the wrong reason is worse than no inbox.
 *   - A READ/UNREAD STATE. Nothing tracks what anybody has read, and a read
 *     model kept in one browser's storage would disagree with itself across two
 *     tabs of the same person. "Waiting on you" is computed from the thread,
 *     not from what you have looked at.
 *   - ANYTHING OUTSIDE THE ACTIVE PROJECT. Scoped like every other
 *     project-scoped surface here, through `activeProject`.
 */

const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { URI } = require('@theia/core/lib/common/uri');
const { open } = require('@theia/core/lib/browser/opener-service');
const { activeProject } = require('./active-project');
const { ICONS } = require('./icons');
const { esc, avatarHtml } = require('./comment-ui');
const { identity } = require('./identity');
const { presence } = require('./presence-client');
const { CommentLog } = require('./comment-log');
const { ChangesStore } = require('./changes-store');
const sidecarScan = require('./sidecar-scan');
const scan = require('./collab-scan');

const COLLAB_WIDGET_ID = 'studio-collaboration';

/* The roster is the only part that goes stale on its own — threads and pending
 * changes are files, and the file watcher reports those. Slower than the
 * heartbeat behind it (4s): a panel that repaints faster than a person reads it
 * is a panel that flickers. */
const ROSTER_POLL_MS = 6000;

/* A file write triggers a rescan, and a save with autosave on is a burst. */
const RESCAN_DEBOUNCE_MS = 400;

/* How many documents' comment logs one refresh will fold. A project can hold
 * more, and the honesty line says when it did. */
const MAX_DOCUMENTS = 400;

function relativePath(rootString, uriString) {
    return uriString.startsWith(rootString)
        ? uriString.slice(rootString.length).replace(/^\//, '')
        : uriString;
}

class CollaborationWidget extends Widget {

    constructor(ctx) {
        super();
        this.workspaceService = ctx.workspaceService;
        this.fileService = ctx.fileService;
        this.openerService = ctx.openerService;
        this.messageService = ctx.messageService;
        this.commandRegistry = ctx.commandRegistry;

        this.commentLog = new CommentLog(ctx.fileService, ctx.workspaceService);
        this.changesStore = new ChangesStore(ctx.fileService, ctx.workspaceService);

        // -- state -----------------------------------------------------------
        this.roster = { people: [], anonymous: 0 };
        this.result = { items: [], truncated: 0, threadsSeen: 0, resolved: 0, mentions: 0, waiting: 0, open: 0 };
        this.pending = { available: false, files: [] };
        this.stats = { documents: 0, projects: 0, unreadable: 0 };
        /* The root every path on the page is stated relative to. Held rather
         * than re-read at paint time: `activeProject.get()` is empty until
         * somebody has chosen a project, while `resolve` falls back to the
         * first root — so the two disagree on exactly the first load, and a
         * roster that printed absolute container paths is what that looks
         * like. */
        this.rootString = '';
        this.scanning = false;
        this.token = undefined;
        this.disposables = [];

        this.id = COLLAB_WIDGET_ID;
        this.title.label = 'Collaboration';
        this.title.caption = 'Who is here, what is being discussed, what is waiting';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-organization';
        this.addClass('studio-collab');

        this.node.innerHTML =
            '<div class="studio-collab-shell">' +
            '  <div class="studio-collab-head">' +
            '    <h1 class="studio-collab-title">Collaboration</h1>' +
            '    <span class="studio-collab-count" data-collab-count aria-live="polite"></span>' +
            '  </div>' +
            '  <div class="studio-collab-body" data-collab-body></div>' +
            '  <p class="studio-collab-honesty" data-collab-honesty></p>' +
            '</div>';

        this.countEl = this.node.querySelector('[data-collab-count]');
        this.bodyEl = this.node.querySelector('[data-collab-body]');
        this.honestyEl = this.node.querySelector('[data-collab-honesty]');

        this.bodyEl.addEventListener('click', event => this.onActivateRow(event.target));
        /* The rows carry role="button", so Enter and Space have to work or the
         * role is a claim the page does not honour. Space is prevented as well
         * as handled — its default on a focused element is to scroll the page
         * out from under the row that was about to open. */
        this.bodyEl.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') { return; }
            if (!event.target.closest('[data-open-uri]')) { return; }
            event.preventDefault();
            this.onActivateRow(event.target);
        });
    }

    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.start();
        void this.refresh();
    }

    onActivateRequest(msg) {
        super.onActivateRequest(msg);
        // Re-reveal means "tell me again", not "show me what you had": the
        // whole subject of this page is what other people have done since.
        void this.refresh();
    }

    onCloseRequest(msg) {
        this.stop();
        super.onCloseRequest(msg);
        /* Raw Lumino Widget, so nothing disposes it for us — the same
         * constraint SearchWidget and the Quality tab live with, and the reason
         * a stale one has to be dropped rather than reused when reopening. */
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
        /*
         * NOT SUBSCRIBED TO identity.onChanged, although a sign-in changes
         * every "you" on this page — which threads mention you, which are
         * waiting on you. That listener list has no way to unsubscribe
         * (identity.js), so a tab opened and closed a few times would leave
         * dead closures behind it for the life of the page. `onActivateRequest`
         * re-reads, which covers the case a person would notice: coming back to
         * the tab after signing in.
         */
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

    /** The cheap half: one RPC, no filesystem. */
    async refreshRoster() {
        const root = await this.activeRoot();
        if (!root) { return; }
        this.rootString = root.toString();
        const parties = await presence.everyone(root);
        this.roster = scan.roster(parties);
        this.render();
    }

    /**
     * The whole page.
     *
     * One scan at a time, and a newer one cancels the older: the file watcher
     * can fire while a fold is still reading, and two interleaved scans writing
     * `this.result` is how a panel ends up showing half of one project.
     */
    async refresh() {
        if (this.isDisposed) { return; }
        if (this.token) { this.token.cancelled = true; }
        const token = { cancelled: false };
        this.token = token;
        this.scanning = true;

        const root = await this.activeRoot();
        if (!root) {
            this.scanning = false;
            this.roster = { people: [], anonymous: 0 };
            this.result = { items: [], truncated: 0, threadsSeen: 0, resolved: 0, mentions: 0, waiting: 0, open: 0 };
            this.pending = { available: false, files: [] };
            this.stats = { documents: 0, projects: 0, unreadable: 0 };
            this.render();
            return;
        }

        const rootString = root.toString();
        this.rootString = rootString;
        const parties = await presence.everyone(root);
        if (token.cancelled) { return; }
        this.roster = scan.roster(parties);

        let documents = [];
        let unreadable = 0;
        try {
            const sidecars = await sidecarScan.collectSidecars(this.fileService, root, token);
            documents = [...sidecars.comments];
        } catch (e) {
            documents = [];
        }
        if (token.cancelled) { return; }

        const capped = documents.length > MAX_DOCUMENTS;
        const files = [];
        for (const rel of documents.slice(0, MAX_DOCUMENTS)) {
            if (token.cancelled) { return; }
            const uri = new URI(rootString + '/' + rel);
            try {
                const store = await this.commentLog.load(uri);
                files.push({ path: rel, uri: uri.toString(), threads: store.threads });
            } catch (e) {
                // One unreadable sidecar is a number on the honesty line, never
                // an empty page: the other eight documents still have threads.
                unreadable++;
            }
        }
        if (token.cancelled) { return; }

        this.result = scan.inbox(files, identity.current());
        try {
            this.pending = await this.changesStore.pendingFilesStatus(root);
        } catch (e) {
            this.pending = { available: false, files: [] };
        }
        if (token.cancelled) { return; }

        this.stats = {
            documents: files.length,
            projects: 1,
            unreadable,
            cappedDocuments: capped ? documents.length - MAX_DOCUMENTS : 0
        };
        this.scanning = false;
        this.render();
    }

    // -- paint ---------------------------------------------------------------

    render() {
        if (this.isDisposed) { return; }
        this.countEl.textContent = scan.countText(this.result);
        this.bodyEl.innerHTML =
            this.rosterSection() +
            this.threadsSection() +
            this.pendingSection();
        this.honestyEl.textContent = scan.honestyLine({
            documents: this.stats.documents,
            projects: this.stats.projects,
            resolved: this.result.resolved,
            truncated: this.result.truncated,
            shown: this.result.items.length,
            unreadable: this.stats.unreadable
        });
    }

    sectionHtml(title, note, inner) {
        return '<section class="studio-collab-section">' +
            '<h2 class="studio-collab-h">' + esc(title) +
            (note ? '<span class="studio-collab-note">' + esc(note) + '</span>' : '') +
            '</h2>' + inner + '</section>';
    }

    rosterSection() {
        const people = this.roster.people;
        if (people.length === 0) {
            return this.sectionHtml('Here now', '', this.emptyHtml(
                presence.available()
                    ? 'Just you in this project right now.'
                    : 'This session cannot see other people — it is running without the collaboration service.'));
        }
        const rows = people.map(person => {
            const where = person.documents
                .map(doc => relativePath(this.rootString, doc))
                .filter(Boolean);
            const openCount = where.length;
            const detail = openCount === 0
                ? 'in this project'
                : openCount === 1 ? where[0] : openCount + ' documents open';
            return '<li class="studio-collab-person">' +
                avatarHtml(person.author) +
                '<span class="studio-collab-person-name">' + esc(person.author.name || 'Somebody') + '</span>' +
                '<span class="studio-collab-person-where">' + esc(detail) + '</span>' +
                (person.typing ? '<span class="studio-collab-typing">editing</span>' : '') +
                '</li>';
        }).join('');
        const note = this.roster.anonymous
            ? this.roster.anonymous + ' more not signed in'
            : '';
        return this.sectionHtml('Here now', note, '<ul class="studio-collab-people">' + rows + '</ul>');
    }

    threadsSection() {
        if (this.result.items.length === 0) {
            /*
             * Three different nothings, and they must not read alike. "Every
             * thread is resolved" said to a project that has never had a
             * comment is a claim about work nobody did — measured in the
             * running IDE against an empty workspace, which is exactly where a
             * person would first see this page.
             */
            const nothing = this.scanning ? 'Reading the project…'
                : this.result.threadsSeen === 0 ? 'No comments in this project yet.'
                : 'Nothing open. Every thread here is resolved.';
            return this.sectionHtml('Open threads', '', this.emptyHtml(nothing));
        }
        const now = Date.now();
        const rows = this.result.items.map(item => {
            const flag = item.mentionsMe ? 'mentions you'
                : item.waitingOnMe ? 'waiting on you' : '';
            return '<li class="studio-collab-thread' + (flag ? ' is-flagged' : '') + '" ' +
                'data-open-uri="' + esc(item.uri) + '" tabindex="0" role="button">' +
                '<div class="studio-collab-thread-top">' +
                '<span class="studio-collab-path">' + esc(item.path) + '</span>' +
                (flag ? '<span class="studio-collab-flag">' + esc(flag) + '</span>' : '') +
                '<span class="studio-collab-age">' + esc(scan.ageText(item.lastAt, now)) + '</span>' +
                '</div>' +
                (item.quote
                    ? '<div class="studio-collab-quote">' + esc(item.quote) + '</div>'
                    : '<div class="studio-collab-quote is-document">on the whole document</div>') +
                '<div class="studio-collab-last">' +
                '<span class="studio-collab-who">' + esc(item.lastBy || 'Somebody') + '</span>' +
                '<span class="studio-collab-preview">' + esc(item.preview) + '</span>' +
                (item.replies ? '<span class="studio-collab-replies">' + item.replies +
                    (item.replies === 1 ? ' reply' : ' replies') + '</span>' : '') +
                '</div>' +
                '</li>';
        }).join('');
        return this.sectionHtml('Open threads', '', '<ul class="studio-collab-threads">' + rows + '</ul>');
    }

    pendingSection() {
        const files = (this.pending && this.pending.files) || [];
        const waiting = files.filter(file => file.pending > 0);
        if (!this.pending.available) {
            return this.sectionHtml('Waiting for review', '', this.emptyHtml(
                'No pending-change index in this project yet.'));
        }
        if (waiting.length === 0) {
            return this.sectionHtml('Waiting for review', '', this.emptyHtml('Nothing proposed is unreviewed.'));
        }
        // `uri` comes back from the index as a URI object, not a string.
        const rows = waiting.map(file =>
            '<li class="studio-collab-pending" data-open-uri="' + esc(file.uri ? file.uri.toString() : '') + '" tabindex="0" role="button">' +
            '<span class="studio-collab-path">' + esc(file.path) + '</span>' +
            '<span class="studio-collab-pending-count">' + file.pending +
            (file.pending === 1 ? ' change' : ' changes') + '</span>' +
            '</li>').join('');
        return this.sectionHtml('Waiting for review', '', '<ul class="studio-collab-pendings">' + rows + '</ul>');
    }

    emptyHtml(text) {
        return '<p class="studio-collab-empty">' + esc(text) + '</p>';
    }

    onActivateRow(target) {
        const row = target && target.closest ? target.closest('[data-open-uri]') : undefined;
        if (!row) { return; }
        const uri = row.getAttribute('data-open-uri');
        if (!uri) { return; }
        /*
         * Opens the DOCUMENT, not the thread. There is no command to reveal one
         * thread inside the editor's comment rail, and inventing a deep link
         * that scrolled to approximately the right place would be a promise
         * this cannot keep for an anchor that has moved. The rail is one click
         * away once the file is open, which is where answering happens anyway.
         */
        void open(this.openerService, new URI(uri)).catch(error => {
            if (this.messageService) {
                this.messageService.error('Could not open ' + uri.split('/').pop());
            }
            console.warn('[studio] collaboration: could not open', uri, error);
        });
    }
}

const COLLAB_CSS = `
/* --- the collaboration tab ------------------------------------------------ *
 * A reading page, so it borrows the document's measure rather than the dense
 * grid the rails use: one column capped at 760px, three sections with the same
 * heading weight, and rows whose hit area is the whole card. Everything here
 * reuses the shell's tokens; nothing defines a colour of its own. */
.studio-collab { height: 100%; overflow: auto; background: var(--studio-bg); color: var(--studio-text); }
.studio-collab-shell { max-width: 760px; margin: 0 auto; padding: 22px 24px 40px; }
.studio-collab-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 18px; }
.studio-collab-title { font-size: 18px; font-weight: 640; margin: 0; }
.studio-collab-count { font-size: 12px; color: var(--studio-muted); }
.studio-collab-section { margin-bottom: 26px; }
.studio-collab-h {
  font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--studio-muted); margin: 0 0 8px; display: flex; align-items: baseline; gap: 8px;
}
.studio-collab-note { font-weight: 400; text-transform: none; letter-spacing: 0; }
.studio-collab-empty { font-size: 13px; color: var(--studio-muted); margin: 0; }

.studio-collab-people { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.studio-collab-person { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.studio-collab-person-name { font-weight: 600; }
.studio-collab-person-where { color: var(--studio-muted); }
/* "editing" is the one live signal on the page, so it is the one thing that
   carries the accent. It reports presence, never content — the draft behind it
   is not on disk and is not claimed to be known. */
.studio-collab-typing { color: var(--studio-accent); font-weight: 600; }

.studio-collab-threads, .studio-collab-pendings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.studio-collab-thread, .studio-collab-pending {
  border: 1px solid var(--studio-line); border-radius: 8px; padding: 9px 11px;
  cursor: pointer; background: var(--studio-surface);
}
.studio-collab-thread:hover, .studio-collab-pending:hover,
.studio-collab-thread:focus-visible, .studio-collab-pending:focus-visible { border-color: var(--studio-accent); outline: none; }
/* A flagged thread is marked on its edge rather than by a fill: the list is
   read top to bottom and a tinted card would pull the eye out of that order,
   which is the order the ranking already put it in. */
.studio-collab-thread.is-flagged { border-left: 3px solid var(--studio-accent); }
.studio-collab-thread-top { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.studio-collab-path { font-family: var(--studio-mono); color: var(--studio-muted); }
.studio-collab-flag { color: var(--studio-accent); font-weight: 650; }
.studio-collab-age { margin-left: auto; color: var(--studio-muted); }
.studio-collab-quote { font-size: 13px; margin: 3px 0; border-left: 2px solid var(--studio-line); padding-left: 8px; }
.studio-collab-quote.is-document { color: var(--studio-muted); border-left-color: transparent; padding-left: 0; font-style: italic; }
.studio-collab-last { display: flex; align-items: baseline; gap: 6px; font-size: 13px; }
.studio-collab-who { font-weight: 600; }
.studio-collab-preview { color: var(--studio-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-collab-replies { margin-left: auto; font-size: 12px; color: var(--studio-muted); white-space: nowrap; }
.studio-collab-pending { display: flex; align-items: baseline; gap: 10px; font-size: 13px; }
.studio-collab-pending-count { margin-left: auto; color: var(--studio-accent); font-weight: 600; }

.studio-collab-honesty {
  margin: 26px 0 0; padding-top: 12px; border-top: 1px solid var(--studio-line);
  font-family: var(--studio-mono); font-size: 11px; line-height: 1.6; color: var(--studio-muted);
}
`;

module.exports = { CollaborationWidget, COLLAB_CSS, COLLAB_WIDGET_ID };
