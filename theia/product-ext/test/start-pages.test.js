/*
 * A start page per mode: which page the empty dock shows, and which buttons it
 * may draw.
 *
 * Run: `node test/start-pages.test.js` (or `npm run test:start-pages`).
 */

const assert = require('node:assert');
const pages = require('../src/browser/start-pages');
const welcomeScan = require('../src/browser/welcome-scan');

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log('  ok   ' + name);
    } catch (error) {
        failures++;
        console.error('  FAIL ' + name);
        console.error('       ' + (error && error.stack || error));
    }
}

/* The part of Theia's CommandRegistry the layer reads. */
function fakeCommands(table) {
    return {
        getCommand: id => (id in table ? { id } : undefined),
        isEnabled: (id, ...args) => {
            const entry = table[id];
            return typeof entry.enabled === 'function' ? entry.enabled(...args) : !!entry.enabled;
        },
        getAllHandlers: id => (table[id] && table[id].handlers) || []
    };
}

const page = (id, modes) => ({ id, modes, label: id, load: async () => ({ sections: [] }) });

console.log('start pages');

// -- the registry --------------------------------------------------------------

test('a contributor that runs first and the layer meet on the same hub', () => {
    const scope = {};
    // What studio and gearbox-studio write, without importing this file.
    const key = Symbol.for('studio.start-pages.v1');
    scope[key] = scope[key] || { pages: [], sections: [], listeners: [] };
    scope[key].pages.push(page('dev', ['default']));
    const hub = pages.startPageHub(scope);
    assert.strictEqual(hub.pages.length, 1);
    assert.strictEqual(hub.pages[0].id, 'dev');
});

test('registering tells the listeners, and disposing takes the page away again', () => {
    const scope = {};
    let told = 0;
    pages.onStartPagesChanged(() => told++, scope);
    const registration = pages.registerStartPage(page('b', ['gearbox.product']), scope);
    pages.registerStartSection({ id: 'x', load: async () => ({}) }, scope);
    assert.strictEqual(told, 2);
    registration.dispose();
    assert.strictEqual(pages.startPageHub(scope).pages.length, 0);
    assert.strictEqual(told, 3);
    registration.dispose();
    assert.strictEqual(told, 3, 'a second dispose is a no-op');
});

test('a listener that throws does not stop the others', () => {
    const scope = {};
    let told = 0;
    pages.onStartPagesChanged(() => { throw new Error('boom'); }, scope);
    pages.onStartPagesChanged(() => told++, scope);
    pages.registerStartPage(page('a', ['default']), scope);
    assert.strictEqual(told, 1);
});

// -- which page -----------------------------------------------------------------

test('Doc editing and a build with no modes keep the documents page', () => {
    const registered = [page('docs-override', ['studio.documents'])];
    assert.strictEqual(pages.pageForMode('studio.documents', registered, welcomeScan.startPageShownIn), pages.DOCUMENTS_PAGE);
    assert.strictEqual(pages.pageForMode(undefined, registered, welcomeScan.startPageShownIn), pages.DOCUMENTS_PAGE);
    assert.strictEqual(pages.pageForMode('', [], welcomeScan.startPageShownIn), pages.DOCUMENTS_PAGE);
});

test('every other mode gets the page registered for it, or none', () => {
    const dev = page('dev', ['default']);
    const building = page('building', ['gearbox.product']);
    const registered = [dev, building];
    assert.strictEqual(pages.pageForMode('default', registered, welcomeScan.startPageShownIn), dev);
    assert.strictEqual(pages.pageForMode('gearbox.product', registered, welcomeScan.startPageShownIn), building);
    assert.strictEqual(pages.pageForMode('studio.orca-mode', registered, welcomeScan.startPageShownIn), undefined);
});

test('the last page registered for a mode wins, and a page without load is ignored', () => {
    const first = page('first', ['studio.full']);
    const second = page('second', ['studio.full']);
    const broken = { id: 'broken', modes: ['studio.full'] };
    assert.strictEqual(pages.pageForMode('studio.full', [first, second, broken], welcomeScan.startPageShownIn), second);
});

// -- the buttons ----------------------------------------------------------------

test('a command this build does not have is not drawn', () => {
    assert.strictEqual(pages.actionState(fakeCommands({}), { command: 'nope', label: 'Nope' }), undefined);
    assert.strictEqual(pages.actionState(undefined, { command: 'nope', label: 'Nope' }), undefined);
});

test('an enabled command is drawn enabled, with its title', () => {
    const state = pages.actionState(fakeCommands({ run: { enabled: true } }), { command: 'run', label: 'Run', title: 'Run it' });
    assert.deepStrictEqual(state, { enabled: true, title: 'Run it' });
});

test('a disabled command says why when its handler can, and something when it cannot', () => {
    const commands = fakeCommands({
        push: { enabled: false, handlers: [{ disabledReason: () => 'open a project first' }] },
        mute: { enabled: false, handlers: [{}] },
        broken: { enabled: false, handlers: [{ disabledReason: () => { throw new Error('x'); } }] }
    });
    assert.deepStrictEqual(pages.actionState(commands, { command: 'push', label: 'Push' }),
        { enabled: false, title: 'Push — open a project first' });
    assert.strictEqual(pages.actionState(commands, { command: 'mute', label: 'Mute' }).title, 'Mute — not available right now');
    assert.strictEqual(pages.actionState(commands, { command: 'broken', label: 'Broken' }).enabled, false);
});

test('the arguments reach isEnabled and disabledReason', () => {
    const seen = [];
    const commands = fakeCommands({ open: { enabled: (...args) => { seen.push(args); return false; }, handlers: [{ disabledReason: arg => 'not ' + arg }] } });
    const state = pages.actionState(commands, { command: 'open', label: 'Open', args: ['x'] });
    assert.deepStrictEqual(seen, [['x']]);
    assert.strictEqual(state.title, 'Open — not x');
});

test('a page may disable a command it knows cannot run, with its own reason', () => {
    const state = pages.actionState(fakeCommands({ create: { enabled: true } }),
        { command: 'create', label: 'New Product', enabled: false, reason: 'the Gearbox engine is not running' });
    assert.deepStrictEqual(state, { enabled: false, title: 'New Product — the Gearbox engine is not running' });
    // ...but not conjure a command that is not there.
    assert.strictEqual(pages.actionState(fakeCommands({}), { command: 'create', label: 'x', enabled: false }), undefined);
});

test('an action the page runs itself is as enabled as the page says', () => {
    assert.deepStrictEqual(pages.actionState(fakeCommands({}), { label: 'Agents', activate: () => {} }), { enabled: true, title: 'Agents' });
    assert.strictEqual(pages.actionState(fakeCommands({}), { label: 'Agents', activate: () => {}, enabled: false }).enabled, false);
});

test('the head draws at most four buttons, skipping what is missing, in order', () => {
    const commands = fakeCommands({ a: { enabled: true }, c: { enabled: false }, d: { enabled: true }, e: { enabled: true }, f: { enabled: true } });
    const drawn = pages.visibleActions(commands, ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ command: id, label: id })));
    assert.deepStrictEqual(drawn.map(d => d.action.command), ['a', 'c', 'd', 'e']);
    assert.deepStrictEqual(drawn.map(d => d.state.enabled), [true, false, true, true]);
});

// -- the rows -------------------------------------------------------------------

test('a row opens, runs, activates, or is plain text', () => {
    const commands = fakeCommands({ go: { enabled: true }, stop: { enabled: false } });
    assert.strictEqual(pages.rowState(commands, { name: 'a', open: 'file:///a' }).kind, 'open');
    assert.strictEqual(pages.rowState(commands, { name: 'a', activate: () => {} }).kind, 'activate');
    assert.deepStrictEqual(pages.rowState(commands, { name: 'a', command: 'go' }), { kind: 'command', enabled: true, title: 'a' });
    assert.strictEqual(pages.rowState(commands, { name: 'a', command: 'stop' }).enabled, false);
    assert.strictEqual(pages.rowState(commands, { name: 'a', command: 'gone' }).kind, 'none');
    assert.strictEqual(pages.rowState(commands, { name: 'a' }).kind, 'none');
});

test('a row the page knows cannot run now is drawn disabled, saying why', () => {
    const commands = fakeCommands({ go: { enabled: true } });
    assert.deepStrictEqual(pages.rowState(commands, { name: 'shop', activate: () => {}, enabled: false, reason: 'the engine is not running' }),
        { kind: 'activate', enabled: false, title: 'shop — the engine is not running' });
    assert.strictEqual(pages.rowState(commands, { name: 'x', command: 'go', enabled: false }).enabled, false);
});

// -- the sections ---------------------------------------------------------------

test('a section is capped, counts the rest, and clips what it says', () => {
    const rows = Array.from({ length: 9 }, (_, n) => ({ name: 'row ' + n }));
    const view = pages.sectionView({ id: 's', title: 'Things', rows, more: 2, detail: 'x'.repeat(500) });
    assert.strictEqual(view.rows.length, pages.ROWS_MAX);
    assert.strictEqual(view.more, 2 + 9 - pages.ROWS_MAX);
    const long = pages.sectionView({ title: 'T', rows: [{ name: 'n'.repeat(500) }] });
    assert.ok(long.rows[0].name.length <= 160);
    assert.ok(long.rows[0].name.endsWith('…'));
});

test('a section that says nothing is dropped, and garbage rows do not survive', () => {
    assert.strictEqual(pages.sectionView(undefined), undefined);
    assert.strictEqual(pages.sectionView({ rows: [] }), undefined);
    const view = pages.sectionView({ title: 'T', rows: [null, {}, { name: 'ok' }] });
    assert.deepStrictEqual(view.rows.map(r => r.name), ['ok']);
});

test('sections go into two columns, or one when they all ask for the same', () => {
    const two = pages.columnsOf([{ title: 'a', rows: [] }, { title: 'b', rows: [] }, { title: 'c', column: 0 }]);
    assert.deepStrictEqual(two.map(c => c.map(s => s.title)), [['a', 'c'], ['b']]);
    const one = pages.columnsOf([{ title: 'a', column: 1 }, { title: 'b', column: 1 }]);
    assert.deepStrictEqual(one.map(c => c.map(s => s.title)), [['a', 'b']]);
    assert.deepStrictEqual(pages.columnsOf([]), [[]]);
});

test('a failure reads as a sentence', () => {
    assert.strictEqual(pages.failureText(new Error('Orca is not running')), 'Orca is not running');
    assert.strictEqual(pages.failureText(undefined), 'unknown error');
});

if (failures) {
    console.error(failures + ' failing');
    process.exit(1);
}
console.log('  all passing');
