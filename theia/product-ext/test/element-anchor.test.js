/*
 * Anchoring a comment to something that was rendered.
 *
 * The walker is tree arithmetic, so it is tested against a tree rather than a
 * browser: the fake nodes below carry exactly the four things it reads —
 * `children`, `parentElement`, `hasAttribute`, and the labelling bits. A jsdom
 * here would add a dependency and a second-long startup to check the same
 * arithmetic, and would not check it any harder.
 *
 * What is guarded is the property the whole model rests on: a path describes
 * the DOCUMENT, not the document plus whatever chrome the surface happens to
 * be showing. Every surface that renders a document injects nodes into it, so
 * an anchor that counted them would re-point every time a panel opened.
 *
 * Run: `node test/element-anchor.test.js` (or `npm run test:element-anchor`).
 */

const assert = require('node:assert');
const anchor = require('../src/browser/element-anchor');

/** A node with just enough of an element's surface for the walker. */
function node(tag, options = {}) {
    const el = {
        tagName: tag.toUpperCase(),
        id: options.id || '',
        className: options.className || '',
        textContent: options.text || '',
        children: [],
        parentElement: undefined,
        injected: !!options.injected,
        hasAttribute(name) { return name === anchor.INJECTED && this.injected; }
    };
    for (const child of options.children || []) {
        child.parentElement = el;
        el.children.push(child);
    }
    return el;
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

console.log('element anchor');

// -- there and back ----------------------------------------------------------

test('a path leads back to the element it came from', () => {
    const table = node('table', { text: 'Q3 numbers' });
    const root = node('body', { children: [
        node('h1', { text: 'Brief' }),
        node('section', { children: [node('p', { text: 'prose' }), table] })
    ] });

    const path = anchor.pathOf(table, root);
    assert.deepStrictEqual(path, [1, 1]);
    assert.strictEqual(anchor.resolvePath(path, root), table);
});

test('the root itself is not anchorable', () => {
    // A comment on "the whole document" is a document-scoped thread, which the
    // product already has. An anchor of [] would be a second way to say it.
    const root = node('body');
    assert.strictEqual(anchor.pathOf(root, root), undefined);
    assert.strictEqual(anchor.resolvePath([], root), undefined);
});

test('an element outside the root has no path', () => {
    const stray = node('p');
    assert.strictEqual(anchor.pathOf(stray, node('body')), undefined);
});

// -- injected chrome ---------------------------------------------------------

test('injected nodes are not counted, so a panel does not move every anchor', () => {
    // The defect this model exists for: open a thread panel above a table and a
    // selector-based anchor points at the panel.
    const table = node('table');
    const root = node('body', { children: [node('h1'), table] });
    const before = anchor.pathOf(table, root);

    const panel = node('div', { injected: true });
    panel.parentElement = root;
    root.children.splice(1, 0, panel);

    assert.deepStrictEqual(anchor.pathOf(table, root), before);
    assert.strictEqual(anchor.resolvePath(before, root), table);
});

test('an injected node cannot be anchored to', () => {
    const panel = node('div', { injected: true });
    const root = node('body', { children: [panel] });
    assert.strictEqual(anchor.pathOf(panel, root), undefined);
});

// -- when the document has moved on ------------------------------------------

test('a path that no longer resolves answers undefined, not something else', () => {
    // Ordinary, not exceptional: documents are edited between a comment and the
    // reading of it. What must never happen is quietly pointing at whatever now
    // sits in that position — hence the surface asks for reattachment.
    const root = node('body', { children: [node('h1'), node('table')] });
    assert.strictEqual(anchor.resolvePath([5], root), undefined);
    assert.strictEqual(anchor.resolvePath([1, 0], root), undefined);
});

test('what was lost can still be described', () => {
    const table = node('table', { id: 'q3', text: 'Q3 numbers by region' });
    const root = node('body', { children: [table] });
    const stored = anchor.anchorFor(table, root);

    assert.strictEqual(stored.type, 'element');
    assert.strictEqual(stored.tag, 'table');
    assert.strictEqual(stored.describe, 'table#q3');
    assert.strictEqual(stored.snippet, 'Q3 numbers by region');
    assert.strictEqual(anchor.lostText(stored), 'table#q3 — Q3 numbers by region');
});

test('an anchor is never stored without a path in it', () => {
    const root = node('body');
    assert.strictEqual(anchor.anchorFor(node('p'), root), undefined);
});

// -- the description ---------------------------------------------------------

test('the description is structural: tag, then id, else first class', () => {
    assert.strictEqual(anchor.describe(node('h2')), 'h2');
    assert.strictEqual(anchor.describe(node('h2', { id: 'risks' })), 'h2#risks');
    assert.strictEqual(anchor.describe(node('div', { className: 'chart wide' })), 'div.chart');
    // An id wins: it is the more specific of the two and the one a person
    // recognises in a page they wrote.
    assert.strictEqual(anchor.describe(node('div', { id: 'x', className: 'chart' })), 'div#x');
});

test('a snippet is one line, trimmed, and bounded', () => {
    const long = node('p', { text: '  lots   of\n   whitespace ' + 'x'.repeat(200) });
    const snippet = anchor.snippetOf(long);
    assert.ok(snippet.startsWith('lots of whitespace'), snippet);
    assert.strictEqual(snippet.length, 90);
});


// -- an area inside an element (requirement 23) ------------------------------

const box = (left, top, width, height) => ({ left, top, width, height });

test('an area is stored as fractions, not pixels', () => {
    // The whole requirement: "stored relative to its page, slide, image or
    // canvas". Pixels would put a rectangle over the middle of a diagram the
    // first time somebody read it in a narrower window.
    const area = anchor.areaIn(box(150, 100, 100, 50), box(100, 100, 400, 200));
    assert.deepStrictEqual(area, { x: 0.125, y: 0, w: 0.25, h: 0.25 });
});

test('the same fractions land on the same part after a resize', () => {
    const drawn = anchor.areaIn(box(200, 100, 100, 50), box(100, 100, 400, 200));
    const stored = { type: 'area', path: [0], area: drawn, aspect: 2 };
    // Half the width, half the height: the same quarter of the picture.
    const placed = anchor.placeArea(stored, box(0, 0, 200, 100));
    assert.deepStrictEqual(placed, { left: 50, top: 0, width: 50, height: 25 });
});

test('a drag that leaves the element is clamped to it', () => {
    const area = anchor.areaIn(box(-50, -50, 1000, 1000), box(0, 0, 100, 100));
    assert.deepStrictEqual(area, { x: 0, y: 0, w: 1, h: 1 });
});

test('a drag that is really a click is not an area', () => {
    assert.strictEqual(anchor.areaIn(box(10, 10, 0, 0), box(0, 0, 100, 100)), undefined);
    assert.strictEqual(anchor.areaIn(box(10, 10, 0.5, 40), box(0, 0, 100, 100)), undefined);
});

test('an element with no box cannot hold an area', () => {
    // A collapsed or hidden container divides by zero, and a fraction of
    // nothing is not an anchor.
    assert.strictEqual(anchor.areaIn(box(0, 0, 10, 10), box(0, 0, 0, 0)), undefined);
});

test('an area anchor carries where, how big, and what shape it was', () => {
    const el = node('img', { id: 'diagram' });
    const root = node('body', { children: [el] });
    const stored = anchor.areaAnchorFor(el, root, box(10, 0, 40, 25), box(0, 0, 200, 100));
    assert.strictEqual(stored.type, 'area');
    assert.deepStrictEqual(stored.path, [0]);
    assert.strictEqual(stored.aspect, 2);
    assert.strictEqual(stored.describe, 'img#diagram');
    assert.deepStrictEqual(stored.area, { x: 0.05, y: 0, w: 0.2, h: 0.25 });
});

test('an area is never stored without a path in it', () => {
    const root = node('body');
    assert.strictEqual(anchor.areaAnchorFor(node('img'), root, box(0, 0, 10, 10), box(0, 0, 100, 100)), undefined);
});

// -- when placement stops being trustworthy ----------------------------------

test('a resize is not a reshape, so the area is still placed', () => {
    const stored = { type: 'area', area: { x: 0, y: 0, w: 1, h: 1 }, aspect: 2 };
    assert.strictEqual(anchor.aspectDrifted(stored, box(0, 0, 400, 200)), false);
    assert.strictEqual(anchor.aspectDrifted(stored, box(0, 0, 200, 100)), false);
    assert.strictEqual(anchor.aspectDrifted(stored, box(0, 0, 40, 20)), false);
});

test('a reshape asks for reattachment instead of moving the area', () => {
    // A diagram that was wide and is now tall has rearranged its own contents,
    // so the same fractions now cover something else. Requirement 23: "asks for
    // reattachment rather than silently moving it".
    const stored = { type: 'area', area: { x: 0, y: 0, w: 1, h: 1 }, aspect: 2 };
    assert.strictEqual(anchor.aspectDrifted(stored, box(0, 0, 100, 200)), true);
    assert.strictEqual(anchor.aspectDrifted(stored, box(0, 0, 400, 100)), true);
});

test('drift is symmetric: half as wide is as suspicious as twice as wide', () => {
    const wide = { type: 'area', aspect: 2 };
    const tall = { type: 'area', aspect: 0.5 };
    assert.strictEqual(anchor.aspectDrifted(wide, box(0, 0, 100, 100)),
        anchor.aspectDrifted(tall, box(0, 0, 100, 100)));
});

test('an anchor written before the ratio existed is still placeable', () => {
    // An old comment is not evidence of a reshape, and refusing to place it
    // would lose every area anchor written before this field.
    assert.strictEqual(anchor.aspectDrifted({ type: 'area', area: {} }, box(0, 0, 10, 100)), false);
});

if (failures) {
    console.error(failures + ' failing');
    process.exit(1);
}
console.log('  all passing');
