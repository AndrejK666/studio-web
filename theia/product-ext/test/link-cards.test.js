/*
 * What a link is, read from the link.
 *
 * Every case here is a URL somebody actually pastes into a PRD. The value of
 * the feature is entirely in getting these right and in not guessing about
 * anything else: a card that says the wrong ticket is worse than a raw URL,
 * because a raw URL is obviously a raw URL.
 *
 * Run: `node test/link-cards.test.js` (or `npm run test:link-cards`).
 */

const assert = require('node:assert');
const cards = require('../src/browser/link-cards');

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

console.log('link cards');

// -- the four kinds ----------------------------------------------------------

test('a pull request is named by its number and its repository', () => {
    const card = cards.recognise('https://github.com/constructorfabric/studio-web/pull/277');
    assert.strictEqual(card.kind, 'change');
    assert.strictEqual(card.title, '#277');
    assert.strictEqual(card.subtitle, 'constructorfabric/studio-web');
    assert.strictEqual(card.badge, 'pull request');
});

test('a merge request is the same thing under its own name', () => {
    const card = cards.recognise('https://gitlab.com/acme/specs/-/merge_requests/12');
    assert.strictEqual(card.kind, 'change');
    assert.strictEqual(card.badge, 'merge request');
    assert.strictEqual(card.title, '#12');
});

test('an issue in a forge', () => {
    const card = cards.recognise('https://github.com/acme/specs/issues/9');
    assert.strictEqual(card.kind, 'issue');
    assert.strictEqual(card.title, '#9');
    assert.strictEqual(card.subtitle, 'acme/specs');
});

test('a tracker key is the title, because it is what people say out loud', () => {
    const card = cards.recognise('https://acme.atlassian.net/browse/PRD-142');
    assert.strictEqual(card.kind, 'tracker');
    assert.strictEqual(card.title, 'PRD-142');
    assert.strictEqual(card.host, 'acme.atlassian.net');
});

test('a repository, once the more specific rules have had their turn', () => {
    const card = cards.recognise('https://github.com/constructorfabric/studio-web');
    assert.strictEqual(card.kind, 'repository');
    assert.strictEqual(card.title, 'constructorfabric/studio-web');
});

test('the more specific answer wins over the repository one', () => {
    // A pull request URL also contains a repository. Answering "repository"
    // would be true and useless.
    assert.strictEqual(
        cards.recognise('https://github.com/acme/specs/pull/3').kind, 'change');
});

// -- what it refuses to guess about ------------------------------------------

test('a link it does not recognise is left alone', () => {
    assert.strictEqual(cards.recognise('https://example.com/some/page'), undefined);
    assert.strictEqual(cards.recognise('https://github.com/acme'), undefined);
    assert.strictEqual(cards.recognise('https://github.com/acme/specs/tree/main/docs'), undefined);
});

test('a relative link is not a resource', () => {
    // It points inside the repository, where the editor can already open it.
    assert.strictEqual(cards.recognise('./docs/prd.md'), undefined);
    assert.strictEqual(cards.recognise('/docs/prd.md'), undefined);
    assert.strictEqual(cards.recognise(''), undefined);
    assert.strictEqual(cards.recognise(undefined), undefined);
});

test('a number that is not a number is not an issue', () => {
    assert.strictEqual(cards.recognise('https://github.com/acme/specs/issues/new'), undefined);
    assert.strictEqual(cards.recognise('https://github.com/acme/specs/pull/latest'), undefined);
});

test('a key-shaped word that is not in a tracker path is not a ticket', () => {
    // `ABC-123` appears in filenames and branch names constantly.
    assert.strictEqual(cards.recognise('https://example.com/files/ABC-123'), undefined);
});

test('the query and the fragment are not part of the answer', () => {
    const card = cards.recognise('https://github.com/acme/specs/pull/3?w=1#discussion');
    assert.strictEqual(card.title, '#3');
    assert.strictEqual(card.subtitle, 'acme/specs');
});

test('a clone URL is not a repository card', () => {
    assert.strictEqual(cards.recognise('https://github.com/acme/specs.git'), undefined);
});

// -- what a project allows ---------------------------------------------------

test('a kind a project turned off is simply not recognised', () => {
    const url = 'https://acme.atlassian.net/browse/PRD-142';
    assert.strictEqual(cards.recognise(url, ['change', 'issue']), undefined);
    assert.strictEqual(cards.recognise(url, cards.KINDS).kind, 'tracker');
});

test('turning off the specific kind falls through to the general one', () => {
    // Which is the honest consequence of a table tried in order, and worth
    // pinning: the link still gets a card, just a less specific one.
    const url = 'https://github.com/acme/specs/pull/3';
    assert.strictEqual(cards.recognise(url, ['repository']), undefined);
    assert.strictEqual(cards.recognise('https://github.com/acme/specs', ['repository']).kind,
        'repository');
});

test('a recogniser that throws is indistinguishable from one that misses', () => {
    // Requirement 21: a failing plugin preserves the original resource and does
    // not block editing. The cheapest way to keep that promise is for a failure
    // to be a miss.
    const original = cards.RECOGNISERS[0].match;
    cards.RECOGNISERS[0].match = () => { throw new Error('boom'); };
    const warn = console.warn;
    console.warn = () => {};
    try {
        // Not "some other card": a pull request URL matches no other rule, so
        // the honest outcome of a failure is exactly the outcome of a miss —
        // the link stays a link.
        assert.strictEqual(cards.recognise('https://github.com/acme/specs/pull/3'), undefined);
        // And the failure is contained: the next URL still gets its card.
        assert.strictEqual(cards.recognise('https://github.com/acme/specs/issues/9').kind, 'issue');
    } finally {
        cards.RECOGNISERS[0].match = original;
        console.warn = warn;
    }
});

// -- where a card is allowed at all ------------------------------------------

test('a card is for a link standing on its own, not one inside a sentence', () => {
    const url = 'https://github.com/acme/specs/pull/3';
    assert.strictEqual(cards.isBareLink(url, url), true);
    assert.strictEqual(cards.isBareLink('<' + url + '>', url), true);
    assert.strictEqual(cards.isBareLink('see the change', url), false);
    assert.strictEqual(cards.isBareLink('', url), false);
});

if (failures) {
    console.error(failures + ' failing');
    process.exit(1);
}
console.log('  all passing');
