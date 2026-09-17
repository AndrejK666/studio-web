/*
 * The collaboration inbox, as arithmetic — no DOM, no Theia, nothing that needs
 * a window.
 *
 * Same split as `search-scan.js`, for the same reason: everything hard here is
 * a pure question with a checkable answer — is this thread waiting on me, does
 * it mention me, which of two threads should a person look at first, what can
 * this panel honestly claim to have read — and everything easy is markup. Kept
 * together, the interesting half can only be tested by driving a browser, which
 * in practice means it is not tested and the ordering quietly becomes whatever
 * the last person's hack made it.
 *
 * WHAT THE ORDER MEANS, because a list of threads with no order is a list
 * nobody finishes reading. Three bands, and the bands are the product decision:
 *
 *   1. MENTIONS ME. Somebody typed my name. That is the one signal in the data
 *      that is unambiguously addressed at a person.
 *   2. WAITING ON ME. I am in the thread and the last word is somebody else's.
 *      Not "unread" — nothing here tracks what anybody has read, and inventing
 *      a read model that lives in one browser's storage would make the count
 *      disagree with itself across two tabs.
 *   3. EVERYTHING ELSE OPEN, newest first.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - NO ASSIGNEES. A thread carries no assignee field (comment-log.js), so
 *     "assigned to me" cannot be computed and is not offered. The business
 *     requirements ask for one; the honest answer today is that the data model
 *     does not have it yet, and a filter that silently matched nothing would be
 *     worse than its absence.
 *   - NO SEVERITY, NO PRIORITY. Nothing in a comment carries either.
 *   - NO CROSS-TOOL THREADS. Comments made in Figma, GitHub or Slack are not in
 *     the repository, so they are not here. `honestyLine` says so rather than
 *     leaving a person to conclude a quiet inbox means a quiet project.
 */

const { slug } = require('./identity');

/* Enough to read the gist of a comment in a row that has to stay one line. */
const PREVIEW_MAX = 140;

/* An inbox is a working list, not an archive. Past this the panel says how many
 * it stopped at rather than rendering a wall — the same rule search-scan.js
 * applies to its own caps: the stopping is a value somebody has to spend. */
const INBOX_MAX = 200;

function clip(text, max = PREVIEW_MAX) {
    const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function plural(count, one, many) {
    return count + ' ' + (count === 1 ? one : many);
}

/**
 * How long ago, in the shortest form that is still unambiguous.
 *
 * Deliberately coarse. A comment thread's age is read to decide whether
 * something has been sitting, and "4d" answers that better than a timestamp
 * nobody converts in their head.
 */
function ageText(at, now = Date.now()) {
    const then = Date.parse(at);
    if (!Number.isFinite(then)) { return ''; }
    const seconds = Math.max(0, Math.round((now - then) / 1000));
    if (seconds < 60) { return 'just now'; }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) { return minutes + 'm'; }
    const hours = Math.round(minutes / 60);
    if (hours < 24) { return hours + 'h'; }
    const days = Math.round(hours / 24);
    if (days < 30) { return days + 'd'; }
    const months = Math.round(days / 30);
    if (months < 12) { return months + 'mo'; }
    return Math.round(months / 12) + 'y';
}

/**
 * Does this text address me by name?
 *
 * Matches the `@name` form the editor inserts (markdown-editor.js's mention
 * suggestions), compared on the same slug the identity module uses everywhere
 * else, so "@Roma", "@roma" and "@Roma Ivanov" all resolve the way the rest of
 * the product resolves a name. An unnamed identity matches nothing, which is
 * correct: nobody can have addressed a person who has no name yet.
 */
function mentions(text, me) {
    if (!me || me.unnamed || !me.name) { return false; }
    const target = slug(me.name);
    if (!target) { return false; }
    const body = String(text == null ? '' : text);
    const tokens = body.match(/@[A-Za-z0-9._-]+/g) || [];
    return tokens.some(token => {
        const candidate = slug(token.slice(1));
        // Prefix, not equality: "@Roma" is how somebody writes to Roma Ivanov,
        // and "@roma-ivanov" is how the suggestion list inserts it.
        return !!candidate && (target === candidate || target.startsWith(candidate + '-') || candidate.startsWith(target + '-'));
    });
}

function isMine(author, me) {
    if (!author || !me) { return false; }
    if (author.id && me.id && author.id === me.id) { return true; }
    if (author.kind === 'agent') { return false; }
    return !!me.name && !me.unnamed && String(author.name || '').trim().toLowerCase() === me.name.toLowerCase();
}

/**
 * One open thread, as a row.
 *
 * `undefined` for a resolved thread or one with nothing in it: a thread whose
 * messages were all retracted is not an item with an empty body, it is not an
 * item.
 */
function threadItem(file, thread, me) {
    if (!thread || thread.resolved) { return undefined; }
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    if (messages.length === 0) { return undefined; }

    const first = messages[0];
    const last = messages[messages.length - 1];
    const mine = messages.some(message => isMine(message.by, me));
    const addressed = messages.some(message => mentions(message.body, me));

    return {
        path: file.path,
        uri: file.uri,
        threadId: thread.id,
        scope: thread.scope === 'document' ? 'document' : 'inline',
        quote: clip(thread.quote, 80),
        openedBy: (first.by && first.by.name) || first.author || '',
        openedAt: first.at,
        lastBy: (last.by && last.by.name) || last.author || '',
        lastAt: last.at,
        preview: clip(last.body),
        replies: messages.length - 1,
        mentionsMe: addressed,
        /* "I am in it and the last word is not mine." A thread I have never
         * written in is not waiting on me, whatever its age. */
        waitingOnMe: mine && !isMine(last.by, me),
        mine
    };
}

/** Which band an item sorts into. Lower is more urgent; see the header. */
function band(item) {
    if (item.mentionsMe) { return 0; }
    if (item.waitingOnMe) { return 1; }
    return 2;
}

/**
 * The inbox: every open thread across the project, ranked.
 *
 * @param files [{ path, uri, threads }] — one entry per document that has any
 * @param me    the identity record the rows are judged against
 */
function inbox(files, me, options = {}) {
    const max = options.max === undefined ? INBOX_MAX : options.max;
    const items = [];
    let threadsSeen = 0;
    let resolved = 0;

    for (const file of files || []) {
        for (const thread of (file.threads || [])) {
            threadsSeen++;
            if (thread && thread.resolved) { resolved++; continue; }
            const item = threadItem(file, thread, me);
            if (item) { items.push(item); }
        }
    }

    items.sort((a, b) => {
        const byBand = band(a) - band(b);
        if (byBand !== 0) { return byBand; }
        // Newest last message first inside a band: a thread somebody replied to
        // this morning is the live one.
        const at = String(b.lastAt || '').localeCompare(String(a.lastAt || ''));
        if (at !== 0) { return at; }
        return String(a.path).localeCompare(String(b.path));
    });

    const truncated = Math.max(0, items.length - max);
    return {
        items: truncated ? items.slice(0, max) : items,
        truncated,
        threadsSeen,
        resolved,
        mentions: items.filter(item => item.mentionsMe).length,
        waiting: items.filter(item => item.waitingOnMe && !item.mentionsMe).length,
        open: items.length
    };
}

/**
 * The roster, folded from per-document parties into per-person.
 *
 * One row per person with the documents they have open, because the question
 * this answers is "who is in the project" and a person with three tabs is one
 * colleague, not three. Parties that never identified themselves are counted
 * but not named — see the node registry for why they can exist at all.
 */
function roster(parties) {
    const people = new Map();
    let anonymous = 0;
    for (const party of parties || []) {
        const author = party.author;
        if (!author || !author.id) { anonymous++; continue; }
        if (!people.has(author.id)) {
            people.set(author.id, { author, documents: [], typing: false });
        }
        const person = people.get(author.id);
        if (party.doc && !person.documents.includes(party.doc)) { person.documents.push(party.doc); }
        if (party.typing) { person.typing = true; }
    }
    const list = [...people.values()].sort((a, b) =>
        String(a.author.name || '').localeCompare(String(b.author.name || '')));
    return { people: list, anonymous };
}

/**
 * What was read, in one line, and what could not be.
 *
 * A collaboration panel is a machine for making people believe they have seen
 * everything said about their work, and in this product they have not: the
 * threads it reads are the ones committed into the repository, and the
 * discussion in Figma, a pull request or a chat is somewhere else entirely.
 * Saying so costs one line and is the difference between a quiet inbox and a
 * false one.
 */
function honestyLine(stats) {
    const parts = [];
    parts.push('Read ' + plural(stats.documents || 0, 'document', 'documents') +
        ' with comments in ' + plural(stats.projects || 0, 'project', 'projects') + '.');
    if (stats.resolved) { parts.push(plural(stats.resolved, 'resolved thread', 'resolved threads') + ' not shown.'); }
    if (stats.truncated) { parts.push('Stopped after ' + stats.shown + '; ' + stats.truncated + ' more.'); }
    if (stats.unreadable) { parts.push(plural(stats.unreadable, 'document', 'documents') + ' could not be read.'); }
    parts.push('Comments made in connected tools are not in the repository and are not here.');
    return parts.join(' ');
}

/** The count line above the list, in the panel's own terms. */
function countText(result) {
    if (result.open === 0) { return 'No open threads'; }
    const parts = [plural(result.open, 'open thread', 'open threads')];
    if (result.mentions) { parts.push(result.mentions + ' mentioning you'); }
    if (result.waiting) { parts.push(result.waiting + ' waiting on you'); }
    return parts.join(' · ');
}

module.exports = {
    ageText, mentions, isMine, threadItem, band, inbox, roster, honestyLine, countText, clip, plural,
    PREVIEW_MAX, INBOX_MAX
};
