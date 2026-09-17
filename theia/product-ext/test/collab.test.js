/*
 * The collaboration inbox: what it puts first, and what it refuses to claim.
 *
 * The ordering is the whole feature. A list of every open thread in a project,
 * in whatever order the filesystem returned the files, is a list nobody reads
 * past the third row — so the cases below are mostly about the three bands and
 * the ways a thread must NOT qualify for one.
 *
 * Run: `node test/collab.test.js` (or `npm run test:collab`).
 */

const assert = require('node:assert');
const scan = require('../src/browser/collab-scan');

const ROMA = { id: 'oidc:sub-1', name: 'Roma', kind: 'person', key: 'oidc-sub-1' };
const ANA = { id: 'oidc:sub-2', name: 'Ana', kind: 'person', key: 'oidc-sub-2' };
const CLAUDE = { id: 'agent:claude', name: 'Claude', kind: 'agent', key: 'agent-claude' };

let clock = Date.parse('2026-09-17T12:00:00.000Z');
function ago(minutes) {
    return new Date(clock - minutes * 60_000).toISOString();
}

function msg(by, body, minutesAgo) {
    return { id: 'm-' + by.key + '-' + minutesAgo, by, author: by.name, at: ago(minutesAgo), body };
}

function thread(id, messages, extra) {
    return Object.assign({ id, scope: 'inline', quote: 'ships in Q3', occurrence: 0, resolved: false, messages }, extra);
}

function file(path, threads) {
    return { path, uri: 'file:///workspace/' + path, threads };
}

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log('  ok   ' + name);
    } catch (error) {
        failures++;
        console.error('  FAIL ' + name);
        console.error('       ' + (error && error.message));
    }
}

console.log('collaboration');

// -- age ---------------------------------------------------------------------

test('age is coarse, because that is how it is read', () => {
    assert.strictEqual(scan.ageText(ago(0), clock), 'just now');
    assert.strictEqual(scan.ageText(ago(20), clock), '20m');
    assert.strictEqual(scan.ageText(ago(180), clock), '3h');
    assert.strictEqual(scan.ageText(ago(60 * 24 * 4), clock), '4d');
    assert.strictEqual(scan.ageText(ago(60 * 24 * 200), clock), '7mo');
    // Nothing invented for a stamp that is not one.
    assert.strictEqual(scan.ageText(undefined, clock), '');
    assert.strictEqual(scan.ageText('not a date', clock), '');
});

// -- mentions ----------------------------------------------------------------

test('a mention is recognised however it was typed', () => {
    assert.strictEqual(scan.mentions('can you check this @Roma', ROMA), true);
    assert.strictEqual(scan.mentions('@roma please look', ROMA), true);
    assert.strictEqual(scan.mentions('@roma-ivanov please look', { ...ROMA, name: 'Roma Ivanov' }), true);
});

test('somebody else’s mention is not mine', () => {
    assert.strictEqual(scan.mentions('@Ana what do you think', ROMA), false);
    assert.strictEqual(scan.mentions('no mentions here', ROMA), false);
    // An email address is not a mention, and neither is a bare name.
    assert.strictEqual(scan.mentions('write to roma@example.com', ROMA), false);
    assert.strictEqual(scan.mentions('Roma wrote this', ROMA), false);
});

test('nobody can have addressed an unnamed person', () => {
    assert.strictEqual(scan.mentions('@you', { id: 'local:anon-1', name: 'You', unnamed: true }), false);
});

// -- one thread --------------------------------------------------------------

test('a resolved thread is not an item', () => {
    const item = scan.threadItem(file('docs/prd.md', []), thread('t1', [msg(ANA, 'done', 5)], { resolved: true }), ROMA);
    assert.strictEqual(item, undefined);
});

test('a thread whose messages were all retracted is not an item', () => {
    // An empty item with a blank preview would be a row that says nothing and
    // cannot be answered.
    assert.strictEqual(scan.threadItem(file('docs/prd.md', []), thread('t1', []), ROMA), undefined);
});

test('an item carries what a row has to show', () => {
    const item = scan.threadItem(
        file('docs/prd.md', []),
        thread('t1', [msg(ANA, 'Is Q3 still right?', 90), msg(ROMA, 'Checking.', 30)]),
        ROMA
    );
    assert.strictEqual(item.path, 'docs/prd.md');
    assert.strictEqual(item.threadId, 't1');
    assert.strictEqual(item.openedBy, 'Ana');
    assert.strictEqual(item.lastBy, 'Roma');
    assert.strictEqual(item.preview, 'Checking.');
    assert.strictEqual(item.replies, 1);
    assert.strictEqual(item.scope, 'inline');
});

test('waiting on me means I am in it and the last word is not mine', () => {
    const inIt = scan.threadItem(file('a.md', []),
        thread('t1', [msg(ROMA, 'Why Q3?', 90), msg(ANA, 'Because of the audit.', 30)]), ROMA);
    assert.strictEqual(inIt.waitingOnMe, true);

    const mineLast = scan.threadItem(file('a.md', []),
        thread('t2', [msg(ANA, 'Why Q3?', 90), msg(ROMA, 'Audit.', 30)]), ROMA);
    assert.strictEqual(mineLast.waitingOnMe, false);

    const neverMine = scan.threadItem(file('a.md', []),
        thread('t3', [msg(ANA, 'Why Q3?', 90), msg(CLAUDE, 'The audit.', 30)]), ROMA);
    // Open, and worth listing — but nobody is waiting on somebody who has
    // never been in the conversation.
    assert.strictEqual(neverMine.waitingOnMe, false);
});

test('an agent’s reply still leaves the thread waiting on me', () => {
    const item = scan.threadItem(file('a.md', []),
        thread('t1', [msg(ROMA, 'Fix this', 90), msg(CLAUDE, 'Proposed a change.', 10)]), ROMA);
    assert.strictEqual(item.waitingOnMe, true);
});

// -- the inbox ---------------------------------------------------------------

test('mentions first, then waiting on me, then the rest newest first', () => {
    const result = scan.inbox([
        file('old.md', [thread('t-old', [msg(ANA, 'a stale note', 60 * 24 * 9)])]),
        file('recent.md', [thread('t-recent', [msg(ANA, 'a fresh note', 5)])]),
        file('waiting.md', [thread('t-wait', [msg(ROMA, 'asked', 120), msg(ANA, 'answered', 100)])]),
        file('mention.md', [thread('t-men', [msg(ANA, 'over to you @Roma', 60 * 24 * 3)])])
    ], ROMA);

    assert.deepStrictEqual(result.items.map(item => item.path),
        ['mention.md', 'waiting.md', 'recent.md', 'old.md']);
    // A mention that is also waiting is counted once, in the band it sorts into.
    assert.strictEqual(result.mentions, 1);
    assert.strictEqual(result.waiting, 1);
    assert.strictEqual(result.open, 4);
});

test('resolved threads are counted, not listed', () => {
    const result = scan.inbox([
        file('a.md', [
            thread('t1', [msg(ANA, 'open', 5)]),
            thread('t2', [msg(ANA, 'settled', 5)], { resolved: true }),
            thread('t3', [msg(ANA, 'settled too', 5)], { resolved: true })
        ])
    ], ROMA);
    assert.strictEqual(result.open, 1);
    assert.strictEqual(result.resolved, 2);
    assert.strictEqual(result.threadsSeen, 3);
});

test('the cap is a number the caller can spend, not silence', () => {
    const threads = [];
    for (let i = 0; i < 12; i++) { threads.push(thread('t' + i, [msg(ANA, 'note ' + i, i + 1)])); }
    const result = scan.inbox([file('a.md', threads)], ROMA, { max: 5 });
    assert.strictEqual(result.items.length, 5);
    assert.strictEqual(result.truncated, 7);
    // And the five kept are the five it ranked first, not the first five read.
    assert.deepStrictEqual(result.items.map(item => item.preview),
        ['note 0', 'note 1', 'note 2', 'note 3', 'note 4']);
});

test('an empty project is an empty inbox, not an error', () => {
    const result = scan.inbox([], ROMA);
    assert.deepStrictEqual(result.items, []);
    assert.strictEqual(scan.countText(result), 'No open threads');
});

test('never commented and all resolved are two different nothings', () => {
    // The view picks its empty state off `threadsSeen`, so the two have to be
    // distinguishable here. Telling a project that has never had a comment
    // that "every thread is resolved" is a claim about work nobody did.
    const never = scan.inbox([file('a.md', [])], ROMA);
    assert.strictEqual(never.open, 0);
    assert.strictEqual(never.threadsSeen, 0);

    const settled = scan.inbox([file('a.md', [thread('t1', [msg(ANA, 'done', 5)], { resolved: true })])], ROMA);
    assert.strictEqual(settled.open, 0);
    assert.strictEqual(settled.threadsSeen, 1);
});

// -- the roster --------------------------------------------------------------

test('one person with three tabs is one colleague', () => {
    const { people, anonymous } = scan.roster([
        { doc: 'file:///w/a.md', author: ANA, typing: false },
        { doc: 'file:///w/b.md', author: ANA, typing: true },
        { doc: 'file:///w/a.md', author: ROMA, typing: false }
    ]);
    assert.strictEqual(people.length, 2);
    const ana = people.find(person => person.author.id === ANA.id);
    assert.strictEqual(ana.documents.length, 2);
    // Typing anywhere is typing: the roster answers "is this person busy".
    assert.strictEqual(ana.typing, true);
    assert.strictEqual(anonymous, 0);
});

test('somebody who never said who they are is counted, not named', () => {
    const { people, anonymous } = scan.roster([
        { doc: 'file:///w/a.md', author: undefined, typing: false },
        { doc: 'file:///w/a.md', author: ANA, typing: false }
    ]);
    assert.strictEqual(people.length, 1);
    assert.strictEqual(anonymous, 1);
});

// -- what the page admits ----------------------------------------------------

test('the honesty line always says what is not in the repository', () => {
    const line = scan.honestyLine({ documents: 9, projects: 1, resolved: 0, truncated: 0, shown: 4, unreadable: 0 });
    assert.ok(line.includes('Read 9 documents with comments in 1 project.'), line);
    assert.ok(line.includes('connected tools'), line);
});

test('and it reports every way the read was incomplete', () => {
    const line = scan.honestyLine({ documents: 9, projects: 2, resolved: 3, truncated: 7, shown: 5, unreadable: 1 });
    assert.ok(line.includes('3 resolved threads not shown.'), line);
    assert.ok(line.includes('Stopped after 5; 7 more.'), line);
    assert.ok(line.includes('1 document could not be read.'), line);
});

test('the count line names the two things worth acting on', () => {
    const result = scan.inbox([
        file('m.md', [thread('t1', [msg(ANA, 'yours @Roma', 10)])]),
        file('w.md', [thread('t2', [msg(ROMA, 'asked', 20), msg(ANA, 'answered', 10)])]),
        file('o.md', [thread('t3', [msg(ANA, 'other', 10)])])
    ], ROMA);
    assert.strictEqual(scan.countText(result), '3 open threads · 1 mentioning you · 1 waiting on you');
});

if (failures) {
    console.error(failures + ' failing');
    process.exit(1);
}
console.log('  all passing');
