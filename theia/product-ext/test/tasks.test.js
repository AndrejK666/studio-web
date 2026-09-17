/*
 * Tasks the documents already carry.
 *
 * Requirement 18 asks for a central list over "recognised Markdown task items"
 * with "supported mention-style assignees". Both halves are guessy in exactly
 * the places a test is for: which lines count, which `@thing` is a person, and
 * what a list nobody ordered is worth.
 *
 * Run: `node test/tasks.test.js` (or `npm run test:tasks`).
 */

const assert = require('node:assert');
const scan = require('../src/browser/task-scan');

const ROMA = { id: 'oidc:sub-1', name: 'Roma', kind: 'person', key: 'oidc-sub-1' };

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

console.log('tasks');

// -- what counts as a task ---------------------------------------------------

test('the three bullet markers and both box states are tasks', () => {
    const found = scan.parseTasks('a.md', [
        '- [ ] dash open',
        '* [x] star done',
        '+ [X] plus done, capital'
    ].join('\n'));
    assert.strictEqual(found.length, 3);
    assert.deepStrictEqual(found.map(t => t.done), [false, true, true]);
});

test('a bullet that is not a box is not a task', () => {
    // A document is mostly prose and lists. Treating every bullet as a task
    // would make the list useless on the first real document it met.
    const found = scan.parseTasks('a.md', [
        '- an ordinary bullet',
        '- [] no space in the box',
        '-[ ] no space after the marker',
        'text [ ] not a list item at all',
        '1. [ ] an ordered item'
    ].join('\n'));
    assert.deepStrictEqual(found, []);
});

test('a task keeps its line and its place in the outline', () => {
    const found = scan.parseTasks('docs/prd.md', [
        '# Brief',
        '',
        '## Risks',
        '',
        '- [ ] ask legal',
        '  - [ ] and the retention clause'
    ].join('\n'));
    assert.strictEqual(found[0].line, 5);
    assert.strictEqual(found[0].heading, 'Risks');
    assert.strictEqual(found[0].depth, 0);
    assert.strictEqual(found[1].depth, 1);
    assert.strictEqual(found[1].heading, 'Risks');
});

// -- who it is addressed to --------------------------------------------------

test('a person and an agent are told apart by the spelling the editor writes', () => {
    const [person] = scan.assigneesOf('ask @roma about it');
    assert.strictEqual(person.kind, 'person');
    assert.strictEqual(person.name, 'roma');

    assert.strictEqual(scan.assigneesOf('hand it to @_claude')[0].kind, 'agent');
    assert.strictEqual(scan.assigneesOf('hand it to @a.claude')[0].kind, 'agent');
    assert.strictEqual(scan.assigneesOf('hand it to @a.claude')[0].name, 'claude');
});

test('two names on one line are two assignees', () => {
    // Markdown has no notion of a single owner, and picking the first would be
    // a rule this product invented.
    const who = scan.assigneesOf('@roma and @ana, together');
    assert.deepStrictEqual(who.map(x => x.name), ['roma', 'ana']);
});

test('the same name twice is one assignee', () => {
    assert.strictEqual(scan.assigneesOf('@roma — @roma, really').length, 1);
});

test('an email address is not a mention', () => {
    assert.deepStrictEqual(scan.assigneesOf('write to roma@example.com'), []);
});

test('a task with no mention is assigned to nobody, which is a real state', () => {
    const [task] = scan.parseTasks('a.md', '- [ ] decide the pricing');
    assert.deepStrictEqual(task.assignees, []);
    assert.strictEqual(scan.assignedTo(task.assignees, ROMA), false);
});

test('mine is decided the way a mention is, and an agent is never me', () => {
    assert.strictEqual(scan.assignedTo(scan.assigneesOf('@Roma do it'), ROMA), true);
    assert.strictEqual(scan.assignedTo(scan.assigneesOf('@roma-ivanov do it'), ROMA), true);
    assert.strictEqual(scan.assignedTo(scan.assigneesOf('@ana do it'), ROMA), false);
    assert.strictEqual(scan.assignedTo(scan.assigneesOf('@_roma do it'), ROMA), false);
});

test('nobody can have addressed a person who has no name yet', () => {
    const anon = { id: 'local:anon-1', name: 'You', unnamed: true };
    assert.strictEqual(scan.assignedTo(scan.assigneesOf('@you do it'), anon), false);
});

// -- the order ---------------------------------------------------------------

test('mine, then somebody else’s, then nobody’s, then done', () => {
    // "Unassigned" below "somebody else's" on purpose: a task with a name on it
    // is already somebody's problem, while an unassigned one is everybody's and
    // therefore nobody's.
    const result = scan.tasks([
        { path: 'a.md', text: [
            '- [ ] nobody at all',
            '- [ ] ask @ana',
            '- [x] finished @Roma',
            '- [ ] over to @Roma'
        ].join('\n') }
    ], ROMA);
    assert.deepStrictEqual(result.items.map(t => t.body), [
        'over to @Roma',
        'ask @ana',
        'nobody at all',
        'finished @Roma'
    ]);
});

test('inside a band the document order is kept', () => {
    const result = scan.tasks([
        { path: 'b.md', text: '- [ ] second document\n- [ ] and its second line' },
        { path: 'a.md', text: '- [ ] first document' }
    ], ROMA);
    assert.deepStrictEqual(result.items.map(t => `${t.path}:${t.line}`),
        ['a.md:1', 'b.md:1', 'b.md:2']);
});

// -- what the surface says ---------------------------------------------------

test('the counts are the three a person acts on', () => {
    const result = scan.tasks([
        { path: 'a.md', text: '- [ ] mine @Roma\n- [ ] theirs @ana\n- [x] done' }
    ], ROMA);
    assert.strictEqual(result.open, 2);
    assert.strictEqual(result.mine, 1);
    assert.strictEqual(result.done, 1);
    assert.strictEqual(scan.countText(result), '2 open · 1 assigned to you · 1 done');
});

test('a project with no tasks says so rather than showing zeroes', () => {
    const result = scan.tasks([{ path: 'a.md', text: '# Just prose' }], ROMA);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.documents, 0);
    assert.strictEqual(scan.countText(result), 'No tasks');
});

test('the cap is a number the caller can spend', () => {
    const lines = [];
    for (let i = 0; i < 12; i++) { lines.push('- [ ] task ' + i); }
    const result = scan.tasks([{ path: 'a.md', text: lines.join('\n') }], ROMA, { max: 5 });
    assert.strictEqual(result.items.length, 5);
    assert.strictEqual(result.truncated, 7);
    assert.strictEqual(result.total, 12);
});

test('the honesty line owns up to the filter requirement 18 asks for', () => {
    // Markdown records no author per line, and inferring one from whoever last
    // edited the file would be wrong exactly when a document has two writers.
    const line = scan.honestyLine(scan.tasks([{ path: 'a.md', text: '- [ ] one' }], ROMA));
    assert.ok(line.includes('Read 1 document with tasks.'), line);
    assert.ok(line.includes('Who wrote a task is not recorded'), line);
});

if (failures) {
    console.error(failures + ' failing');
    process.exit(1);
}
console.log('  all passing');
