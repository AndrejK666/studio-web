// node test/status-line-modes.test.js
//
// The bottom line per mode: Doc editing keeps the product's quiet line, the
// code modes get back the few of Theia's entries a programmer reads there.
const assert = require('assert');
const { CODE_MODE_PERSPECTIVES, CODE_MODE_STATUS_ENTRIES, codeModeStatusCss } = require('../src/browser/status-line-modes.js');

const css = codeModeStatusCss();

// Every code mode, and only the code modes.
for (const mode of ['default', 'studio.full', 'studio.orca-mode', 'gearbox.product']) {
    assert.ok(CODE_MODE_PERSPECTIVES.includes(mode), mode);
    assert.ok(css.includes(`body[data-studio-perspective="${mode}"] #theia-statusBar .element`), mode);
}
assert.ok(!css.includes('studio.documents'), 'Doc editing keeps the quiet line');

// What a code mode needs: branch and sync, Problems, the bell, the bottom panel.
for (const needed of ['[id^="status-bar-scm."]', '[id="status-bar-problem-marker-status"]',
    '[id="status-bar-theia-notification-center"]', '[id="status-bar-bottom-panel-toggle"]',
    '[id="status-bar-connection-status"]']) {
    assert.ok(css.includes(needed), needed);
}

// A named list, not the whole bar: nothing matches every entry.
assert.ok(!/\.element\s*[,{]/.test(css), 'every selector names an entry');
assert.strictEqual(css.split(',\n').length, CODE_MODE_PERSPECTIVES.length * CODE_MODE_STATUS_ENTRIES.length);
assert.ok(css.trim().endsWith('{ display: flex !important; }'));

// It outranks the blanket hide however the stylesheets are ordered:
// `#theia-statusBar .element:not([class*="studio-status-"])` is (1,2,0).
// Enough of CSS specificity for these selectors: ids, classes and attributes, types.
function specificity(selector) {
    const attributes = (selector.match(/\[[^\]]+\]/g) || []).length;
    const bare = selector.replace(/\[[^\]]+\]/g, '[]').replace(/:not\(([^)]*)\)/g, ' $1');
    const ids = (bare.match(/#[\w-]+/g) || []).length;
    const classes = (bare.match(/\.[\w-]+/g) || []).length;
    const types = (bare.match(/(^|\s)[a-z]+/g) || []).length;
    return [ids, classes + attributes, types];
}
assert.deepStrictEqual(specificity('#theia-statusBar .element:not([class*="studio-status-"])'), [1, 2, 0]);
function outranks(a, b) {
    for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) { return a[i] > b[i]; } }
    return false;
}
const hide = [1, 2, 0];
for (const selector of css.replace(/\s*\{[^}]*\}\s*$/, '').split(',\n')) {
    assert.ok(outranks(specificity(selector), hide), selector);
}

// The hide is still in the product's stylesheet, with the code modes' list after it.
const { STATUS_LINE_CSS } = (() => {
    try { return require('../src/browser/status-line.js'); } catch (e) { return {}; }
})();
if (STATUS_LINE_CSS) {
    assert.ok(STATUS_LINE_CSS.includes('#theia-statusBar .element:not([class*="studio-status-"]) { display: none !important; }'));
    assert.ok(STATUS_LINE_CSS.includes(css.trim()));
}

console.log('status-line-modes: ok');
