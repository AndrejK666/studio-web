/*
 * The co-editing roster and write attribution.
 *
 * The roster half is decoration and its failures are cosmetic. The attribution
 * half is not: its answer decides whether a change that arrived from outside is
 * APPLIED to an open document or HELD for review, and getting that wrong in the
 * unsafe direction means an agent's edit lands in somebody's file without
 * anyone having read it. So most of what is below is about the ways a claim
 * must fail to match.
 *
 * Run: `node test/collab-roster.test.js` (or `npm run test:collab-roster`).
 */

const assert = require('node:assert');
const { CollabRegistry } = require('../src/node/collab-registry');
const {
    bodyDigest, PARTY_TTL_MS, WRITE_CLAIM_TTL_MS
} = require('../src/common/collab-protocol');

const DOC = 'file:///workspace/docs/prd.md';
const ROMA = { id: 'oidc:sub-1', name: 'Roma', kind: 'person', key: 'oidc-sub-1' };
const ANA = { id: 'oidc:sub-2', name: 'Ana', kind: 'person', key: 'oidc-sub-2' };

/* A clock the test moves, so nothing here waits on a real one. */
function clocked(start = 1_000_000) {
    const state = { now: start };
    const registry = new CollabRegistry(() => state.now);
    return { registry, tick: ms => { state.now += ms; } };
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

console.log('collab-roster');

// -- the roster --------------------------------------------------------------

test('alone in a document is an empty roster, not a phantom', () => {
    const { registry } = clocked();
    assert.deepStrictEqual(registry.announce('conn-a', DOC, ROMA, false), []);
});

test('two people in one document see each other', () => {
    const { registry } = clocked();
    registry.announce('conn-a', DOC, ROMA, false);
    const others = registry.announce('conn-b', DOC, ANA, true);
    assert.strictEqual(others.length, 1);
    assert.strictEqual(others[0].author.name, 'Roma');
    // Ana said she was typing; Roma did not. Each roster is about the others.
    assert.strictEqual(others[0].typing, false);
    assert.strictEqual(registry.announce('conn-a', DOC, ROMA, false)[0].typing, true);
});

test('my own second tab is me, not a colleague', () => {
    // The whole reason the roster is keyed by author and not by connection: a
    // roster that listed my other tab would put the duplicate-session warning
    // back, this time as somebody who does not exist.
    const { registry } = clocked();
    registry.announce('conn-a', DOC, ROMA, false);
    assert.deepStrictEqual(registry.announce('conn-b', DOC, ROMA, false), []);
});

test('a different document is a different room', () => {
    const { registry } = clocked();
    registry.announce('conn-a', DOC, ROMA, false);
    assert.deepStrictEqual(registry.announce('conn-b', 'file:///workspace/README.md', ANA, false), []);
});

test('a closed tab expires instead of lingering', () => {
    // Nobody gets to say goodbye when a browser goes away, so the entry has to
    // fall out on its own.
    const { registry, tick } = clocked();
    registry.announce('conn-a', DOC, ROMA, false);
    tick(PARTY_TTL_MS + 1);
    assert.deepStrictEqual(registry.announce('conn-b', DOC, ANA, false), []);
});

test('leaving is immediate when the browser can say so', () => {
    const { registry } = clocked();
    registry.announce('conn-a', DOC, ROMA, false);
    registry.depart('conn-a', DOC);
    assert.deepStrictEqual(registry.announce('conn-b', DOC, ANA, false), []);
});

test('a project roster spans its documents and stops at its edge', () => {
    // What the collaboration tab asks: who is in THIS project. Asking per
    // document would mean already knowing which documents to ask about.
    const { registry } = clocked();
    registry.announce('conn-a', 'file:///workspace/alpha/docs/prd.md', ROMA, false);
    registry.announce('conn-b', 'file:///workspace/alpha/README.md', ANA, true);
    registry.announce('conn-c', 'file:///workspace/beta/notes.md', ANA, false);

    const alpha = registry.everyone('file:///workspace/alpha');
    assert.strictEqual(alpha.length, 2);
    assert.deepStrictEqual(alpha.map(party => party.doc).sort(), [
        'file:///workspace/alpha/README.md',
        'file:///workspace/alpha/docs/prd.md'
    ]);
    // Everybody, including the caller: a project roster that left them out
    // would say "nobody is here" to somebody who plainly is.
    assert.strictEqual(registry.everyone('').length, 3);
});

test('a project roster forgets a party that stopped beating', () => {
    const { registry, tick } = clocked();
    registry.announce('conn-a', 'file:///workspace/alpha/a.md', ROMA, false);
    tick(PARTY_TTL_MS + 1);
    assert.deepStrictEqual(registry.everyone('file:///workspace/alpha'), []);
});

// -- write attribution -------------------------------------------------------

test('a claimed write names its writer', () => {
    const { registry } = clocked();
    const body = '# PRD\n\nShips in Q4.\n';
    registry.claimWrite(DOC, ANA, bodyDigest(body));
    const writer = registry.lastWriter(DOC, bodyDigest(body));
    assert.strictEqual(writer.author.name, 'Ana');
});

test('an unclaimed write names nobody, so it is held for review', () => {
    // An agent writing through the filesystem, a git checkout, a hand edit in
    // a terminal. All three must keep the behaviour the product already had.
    const { registry } = clocked();
    assert.strictEqual(registry.lastWriter(DOC, bodyDigest('anything')), undefined);
});

test('a claim answers only for the content it was made for', () => {
    // The case with teeth: Ana saves, and an agent writes the file a moment
    // later while her claim is still live. Matching on time alone would apply
    // the agent's edit as Ana's, unreviewed.
    const { registry } = clocked();
    registry.claimWrite(DOC, ANA, bodyDigest('what Ana wrote'));
    assert.strictEqual(registry.lastWriter(DOC, bodyDigest('what the agent wrote')), undefined);
});

test('a claim does not answer for another document', () => {
    const { registry } = clocked();
    const body = 'shared text';
    registry.claimWrite(DOC, ANA, bodyDigest(body));
    assert.strictEqual(registry.lastWriter('file:///workspace/other.md', bodyDigest(body)), undefined);
});

test('a claim expires', () => {
    const { registry, tick } = clocked();
    const body = 'text';
    registry.claimWrite(DOC, ANA, bodyDigest(body));
    tick(WRITE_CLAIM_TTL_MS + 1);
    assert.strictEqual(registry.lastWriter(DOC, bodyDigest(body)), undefined);
});

test('the newer write supersedes the older claim on the same document', () => {
    const { registry } = clocked();
    registry.claimWrite(DOC, ROMA, bodyDigest('first'));
    registry.claimWrite(DOC, ANA, bodyDigest('second'));
    assert.strictEqual(registry.lastWriter(DOC, bodyDigest('second')).author.name, 'Ana');
    // And the superseded one can no longer be redeemed, which is what keeps a
    // stale claim from attributing a revert to whoever wrote that text first.
    assert.strictEqual(registry.lastWriter(DOC, bodyDigest('first')), undefined);
});

// -- what crosses the wire ---------------------------------------------------

test('an author record is taken apart rather than trusted', () => {
    // The roster is broadcast to every other browser in the workspace, so a
    // frontend cannot smuggle extra fields into one.
    const { registry } = clocked();
    registry.announce('conn-a', DOC, {
        id: 'oidc:sub-1', name: 'Roma', kind: 'person', key: 'oidc-sub-1',
        token: 'not yours', admin: true
    }, false);
    const seen = registry.announce('conn-b', DOC, ANA, false)[0].author;
    assert.deepStrictEqual(Object.keys(seen).sort(), ['id', 'key', 'kind', 'name']);
});

test('an unknown kind is reported as a person, never invented', () => {
    const { registry } = clocked();
    registry.announce('conn-a', DOC, { id: 'x:1', name: 'X', kind: 'administrator' }, false);
    assert.strictEqual(registry.announce('conn-b', DOC, ANA, false)[0].author.kind, 'person');
});

test('an author with no id is not a party', () => {
    const { registry } = clocked();
    registry.announce('conn-a', DOC, { name: 'Anonymous' }, false);
    const others = registry.announce('conn-b', DOC, ANA, false);
    // Still present as a connection — somebody is there — but with nothing to
    // claim they are, which is all that can honestly be said.
    assert.strictEqual(others.length, 1);
    assert.strictEqual(others[0].author, undefined);
});

// -- the digest --------------------------------------------------------------

test('the digest separates what the editor will compare', () => {
    assert.strictEqual(bodyDigest('a'), bodyDigest('a'));
    assert.notStrictEqual(bodyDigest('Ships in Q3.'), bodyDigest('Ships in Q4.'));
    assert.notStrictEqual(bodyDigest('text'), bodyDigest('text '));
    assert.notStrictEqual(bodyDigest(''), bodyDigest('\n'));
    // Whole documents, differing by one character deep inside.
    const long = 'x'.repeat(50_000);
    assert.notStrictEqual(bodyDigest(long + 'a' + long), bodyDigest(long + 'b' + long));
});

if (failures) {
    console.error(failures + ' failing');
    process.exit(1);
}
console.log('  all passing');
