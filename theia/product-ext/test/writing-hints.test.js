/*
 * Writing hints: what a requirement sentence is held to, and what is left alone.
 *
 * The rules are worth only as much as their silence on ordinary prose: a hint
 * under a description, a heading or a well-written requirement teaches people
 * to ignore the underline. So half of these say what is NOT hinted.
 *
 * Run: `node test/writing-hints.test.js` (or `npm run test:writing-hints`).
 */

const assert = require('node:assert');
const { Schema } = require('@tiptap/pm/model');
const { hintsInText, hintsInDoc, sentences, MAX_WORDS } = require('../src/browser/writing-hints');

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

const rules = text => hintsInText(text).map(h => h.rule);
const spanOf = (text, hint) => text.slice(hint.from, hint.to);

console.log('writing hints');

// -- which sentences ---------------------------------------------------------

test('a sentence without a requirement verb is never hinted, however long', () => {
    const text = 'The gateway reads the token from the header, looks up the tenant, checks the scope, '
        + 'and forwards the request to the gear that owns the route, which answers it.';
    assert.deepStrictEqual(rules(text), []);
});

test('a short, active requirement gets nothing', () => {
    assert.deepStrictEqual(rules('The gateway shall reject a request without a token.'), []);
});

test('sentences split at a full stop, not at an abbreviation or inside a number', () => {
    const text = 'Use a cache, e.g. Redis. Version 2.1 is required. Done';
    const parts = sentences(text).map(s => text.slice(s.start, s.end));
    assert.deepStrictEqual(parts, ['Use a cache, e.g. Redis.', 'Version 2.1 is required.', 'Done']);
});

// -- the three rules ---------------------------------------------------------

test('a requirement over the limit is hinted, with its count', () => {
    const text = 'The system shall send every member of the organization an email that lists each document '
        + 'that changed since the last digest and who changed it.';
    const [hint] = hintsInText(text);
    assert.strictEqual(hint.rule, 'writing.long_sentence');
    assert.ok(hint.message.startsWith('25 words'), hint.message);
    assert.strictEqual(spanOf(text, hint), text);
});

test('exactly the limit is not over it', () => {
    const twenty = 'The service shall ' + Array.from({ length: MAX_WORDS - 3 }, () => 'word').join(' ') + '.';
    assert.deepStrictEqual(rules(twenty), []);
});

test('two requirement verbs in one sentence mark the second', () => {
    const text = 'The client must retry and must give up after three attempts.';
    const hint = hintsInText(text).find(h => h.rule === 'writing.two_requirements');
    assert.ok(hint);
    assert.strictEqual(spanOf(text, hint), 'must');
    assert.strictEqual(hint.from, text.lastIndexOf('must'));
});

test('a passive requirement with no actor marks the verb phrase', () => {
    const text = 'Every upload shall be validated before it is stored.';
    const hint = hintsInText(text).find(h => h.rule === 'writing.no_actor');
    assert.ok(hint);
    assert.strictEqual(spanOf(text, hint), 'shall be validated');
});

test('a passive requirement that names its actor with "by" is fine', () => {
    assert.deepStrictEqual(rules('Every upload shall be validated by the file-storage gear.'), []);
});

test('an irregular participle and an adverb are still a passive', () => {
    const text = 'The key must not be written to the log, and it should be securely kept.';
    const spans = hintsInText(text).filter(h => h.rule === 'writing.no_actor').map(h => spanOf(text, h));
    assert.deepStrictEqual(spans, ['must not be written', 'should be securely kept']);
});

test('"is required to" counts as a requirement verb', () => {
    assert.deepStrictEqual(rules('The member is required to be notified.'), ['writing.no_actor']);
});

// -- positions in a real document --------------------------------------------

const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'inline*' },
        heading: { group: 'block', content: 'inline*' },
        codeBlock: { group: 'block', content: 'text*' },
        image: { group: 'inline', inline: true },
        text: { group: 'inline' }
    }
});
const p = (...inline) => schema.node('paragraph', null, inline);
const t = text => schema.text(text);

test('a hint lands on the document positions of its text, past an inline image', () => {
    const doc = schema.node('doc', null, [
        p(t('Intro.')),
        p(t('Logo '), schema.node('image'), t(' Data shall be stored.'))
    ]);
    const [hint] = hintsInDoc(doc);
    assert.strictEqual(hint.rule, 'writing.no_actor');
    assert.strictEqual(doc.textBetween(hint.from, hint.to), 'shall be stored');
});

test('headings and code are not requirements', () => {
    const doc = schema.node('doc', null, [
        schema.node('heading', null, [t('The data shall be stored')]),
        schema.node('codeBlock', null, [t('// the token must be sent')])
    ]);
    assert.deepStrictEqual(hintsInDoc(doc), []);
});

if (failures) {
    console.error(`\n${failures} failing`);
    process.exit(1);
}
