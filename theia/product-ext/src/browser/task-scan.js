/*
 * Tasks, as arithmetic — no DOM, no Theia, nothing that needs a window.
 *
 * Same split as `search-scan.js` and `collab-scan.js`, for the same reason:
 * what a task line IS, who it is addressed to and which of two tasks a person
 * should see first are pure questions with checkable answers, and kept next to
 * the markup they can only be tested by driving a browser.
 *
 * # Where a task lives
 *
 * In the document. `- [ ] ask legal about the retention clause @roma` is a task
 * because Markdown says it is, and this reads what is written rather than
 * keeping a list beside it. That is requirement 18's "task state remains
 * synchronized with source Markdown" taken literally: there is no second copy
 * to synchronize, so it cannot drift. Ticking the box is editing the document,
 * which is where the sentence is anyway.
 *
 * # What it can say, and what it cannot
 *
 *   - ASSIGNEE, from the mention the line carries. `@roma` is a person and
 *     `@_claude` / `@a.claude` is an agent — the same two spellings the editor
 *     inserts (requirement 9). A task with no mention is assigned to nobody,
 *     which is a real state and the common one.
 *   - COMPLETION, from the box.
 *   - SOURCE CONTEXT: the document, and the nearest heading above the line,
 *     because "under Risks" is what makes a one-line task mean anything.
 *
 * It cannot say WHO WROTE IT. Requirement 18 asks for a creator filter and
 * Markdown records no such thing — the history sidecar knows who edited a
 * document, not who wrote a line. Rather than infer an author from whoever
 * last touched the file, which would be wrong exactly when a document has more
 * than one writer, the surface says the filter is absent and why. A filter that
 * silently answers with the wrong name is worse than one that is not offered.
 */

const { slug } = require('./identity');

/* A GitHub-style task item. Indentation is captured so a nested task keeps its
 * place in the document's outline, and the box's letter so `[X]` counts as done
 * the way every Markdown renderer treats it. */
const TASK_LINE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;

/* The two mention spellings the editor inserts. `@_name` and `@a.name` are
 * agents; anything else is a person (markdown-editor.js, requirement 9).
 *
 * The lookbehind is not decoration: without it `roma@example.com` yields an
 * assignee called `example.com`, and a task list that invents a person nobody
 * can find is worse than one that misses a mention. A mention starts a word. */
const MENTION = /(?<![A-Za-z0-9._-])@([A-Za-z0-9._-]+)/g;

/* An ATX heading, for the source context. Setext headings are not read: they
 * need the following line, and a task list is not worth a two-line parser when
 * the product's own editor writes ATX. */
const HEADING = /^(#{1,6})\s+(.*)$/;

/* A working list, not an archive. Past this the surface says how many it
 * stopped at rather than rendering a wall — search-scan.js's rule, that the
 * stopping is a value somebody has to spend. */
const TASK_MAX = 300;

function clip(text, max = 160) {
    const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

/**
 * Who a task line is addressed to.
 *
 * Every mention on the line, in order, de-duplicated. A line can name two
 * people and both are assignees — Markdown has no notion of a single owner,
 * and picking the first would be a rule this product invented.
 */
function assigneesOf(body) {
    const out = [];
    const seen = new Set();
    for (const match of String(body == null ? '' : body).matchAll(MENTION)) {
        const raw = match[1];
        const agent = raw.startsWith('_') || raw.startsWith('a.');
        const name = agent ? raw.replace(/^(_|a\.)/, '') : raw;
        const key = slug(name);
        if (!key || seen.has(key)) { continue; }
        seen.add(key);
        out.push({ raw: '@' + raw, name, key, kind: agent ? 'agent' : 'person' });
    }
    return out;
}

/** Is this one of my names? The prefix rule `collab-scan.mentions` uses. */
function assignedTo(assignees, me) {
    if (!me || me.unnamed || !me.name) { return false; }
    const target = slug(me.name);
    if (!target) { return false; }
    return assignees.some(who =>
        who.kind === 'person' &&
        (who.key === target || target.startsWith(who.key + '-') || who.key.startsWith(target + '-')));
}

/**
 * Every task in one document, with the heading each sits under.
 *
 * @param path the document's project-relative path, carried onto every item
 * @param text the document's Markdown
 */
function parseTasks(path, text) {
    const out = [];
    let heading = '';
    const lines = String(text == null ? '' : text).split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const head = HEADING.exec(line);
        if (head) {
            heading = clip(head[2], 60);
            continue;
        }
        const task = TASK_LINE.exec(line);
        if (!task) { continue; }
        const body = task[3];
        out.push({
            path,
            /* 1-based, because it is shown to a person and used to open the
             * document at the line. */
            line: index + 1,
            depth: Math.floor(task[1].replace(/\t/g, '    ').length / 2),
            done: task[2] !== ' ',
            body: clip(body),
            heading,
            assignees: assigneesOf(body)
        });
    }
    return out;
}

/** Which band an item sorts into. Lower is more urgent. */
function band(item, me) {
    if (item.done) { return 3; }
    if (assignedTo(item.assignees, me)) { return 0; }
    if (item.assignees.length === 0) { return 2; }
    return 1;
}

/**
 * The project's tasks, ranked.
 *
 * Four bands, and the order is the product decision: what is addressed at me,
 * then what is addressed at somebody, then what is addressed at nobody, then
 * what is done. "Unassigned" sits below "somebody else's" on purpose — a task
 * with a name on it is somebody's problem already, while an unassigned one is
 * everybody's and therefore nobody's, and burying it under the done pile is how
 * it stays that way.
 *
 * @param files [{ path, text }]
 * @param me    the identity record "mine" is judged against
 */
function tasks(files, me, options = {}) {
    const max = options.max === undefined ? TASK_MAX : options.max;
    const items = [];
    let documents = 0;
    for (const file of files || []) {
        const found = parseTasks(file.path, file.text);
        if (found.length) { documents++; }
        for (const item of found) { items.push(item); }
    }

    items.sort((a, b) => {
        const byBand = band(a, me) - band(b, me);
        if (byBand !== 0) { return byBand; }
        // Document order inside a band: a task list read against the document
        // it came from is a list somebody can act on.
        const byPath = String(a.path).localeCompare(String(b.path));
        return byPath !== 0 ? byPath : a.line - b.line;
    });

    const mine = items.filter(item => !item.done && assignedTo(item.assignees, me)).length;
    const open = items.filter(item => !item.done).length;
    const truncated = Math.max(0, items.length - max);
    return {
        items: truncated ? items.slice(0, max) : items,
        truncated,
        total: items.length,
        documents,
        mine,
        open,
        done: items.length - open
    };
}


/* The heading a task written from a thread goes under. One place, so a document
 * does not grow three of them under three spellings. */
const TASKS_HEADING = '## Tasks';

/**
 * Write a task line into a document.
 *
 * Under an existing `## Tasks` section when there is one, at the END of it —
 * so the order is the order they were asked for — and in a new section at the
 * foot of the document when there is not.
 *
 * WHY A SECTION AND NOT THE CURSOR. A task made from a comment has no cursor:
 * the person is in the thread, not in the text. Dropping the line beside the
 * quoted sentence would edit the paragraph somebody is discussing, which is the
 * one place in the document it must not land.
 *
 * Returns the whole document. The caller writes it through the editor's own
 * save path, so the change is one edit somebody can undo.
 */
function appendTask(markdown, body, assignee) {
    const text = String(body == null ? '' : body).replace(/\s+/g, ' ').trim();
    if (!text) { return String(markdown == null ? '' : markdown); }
    const mention = String(assignee || '').trim();
    const line = '- [ ] ' + text + (mention ? ' ' + (mention.startsWith('@') ? mention : '@' + mention) : '');

    const lines = String(markdown == null ? '' : markdown).split('\n');
    const heading = lines.findIndex(one => one.trim().toLowerCase() === TASKS_HEADING.toLowerCase());
    if (heading < 0) {
        const out = lines.slice();
        // One blank line before the new section, and never two: a document that
        // grows a gap every time somebody makes a task looks edited by a machine.
        while (out.length && out[out.length - 1].trim() === '') { out.pop(); }
        out.push('', TASKS_HEADING, '', line, '');
        return out.join('\n');
    }

    /* The end of that section: the line before the next heading of the same or
     * a higher level, or the end of the document. A task appended after a
     * SUBsection would leave the section it belongs to and read as part of
     * whatever came next. */
    let end = lines.length;
    for (let i = heading + 1; i < lines.length; i++) {
        if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
    }
    let at = end;
    while (at > heading + 1 && lines[at - 1].trim() === '') { at--; }
    const out = lines.slice(0, at).concat([line], lines.slice(at));
    return out.join('\n');
}

/** The count line above the list, in the surface's own terms. */
function countText(result) {
    if (result.total === 0) { return 'No tasks'; }
    const parts = [result.open + ' open'];
    if (result.mine) { parts.push(result.mine + ' assigned to you'); }
    if (result.done) { parts.push(result.done + ' done'); }
    return parts.join(' · ');
}

/**
 * What the list read, and the one thing it cannot tell you.
 *
 * The creator filter requirement 18 asks for is not here, and saying so is
 * cheaper than a person discovering that "created by" is missing after building
 * a habit on the rest. See the module header for why it cannot be inferred.
 */
function honestyLine(result) {
    const parts = [];
    parts.push('Read ' + result.documents +
        (result.documents === 1 ? ' document' : ' documents') + ' with tasks.');
    if (result.truncated) {
        parts.push('Stopped after ' + result.items.length + '; ' + result.truncated + ' more.');
    }
    parts.push('Who wrote a task is not recorded in Markdown, so there is no filter for it.');
    return parts.join(' ');
}

module.exports = {
    parseTasks, assigneesOf, assignedTo, band, tasks, appendTask, countText, honestyLine, clip,
    TASKS_HEADING,
    TASK_MAX
};
