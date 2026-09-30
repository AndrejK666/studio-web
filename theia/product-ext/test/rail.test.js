// node test/rail.test.js
//
// The left rail's product-owned half. The rail is one toolset in every mode
// (theia/studio's studio-mode-layout.ts, RAIL, with its own jest test); what
// product-ext adds under Theia's tabs is Collaboration, Quality when a project
// turns it on, and ONE Assistants entry — no second search, no button per
// assistant. And the column is measured under the tools, not down to the
// Studio view at the rail's foot.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    assistantsRailHtml, assistantPickItems, RAIL_ASSISTANTS, SLOT_APP_ENTRIES
} = require('../src/browser/slot-strip.js');
const { topRunBottom } = require('../src/browser/rail-nav.js');

const buttons = html => (html.match(/<button\b/g) || []).length;

// One entry for every assistant, whichever is open.
for (const active of [undefined, 'claude', 'codex']) {
    const html = assistantsRailHtml({ active });
    assert.strictEqual(buttons(html), 1, 'one rail button for the assistants');
    assert.ok(html.includes('data-studio-rail="' + RAIL_ASSISTANTS.key + '"'));
    assert.ok(!/data-studio-rail="(claude|codex)"/.test(html), 'no per-assistant rail button');
}

// Closed: quiet, and it names both. Open: pressed, in the open vendor's colour.
const closed = assistantsRailHtml({ active: undefined });
assert.ok(!/class="[^"]*\bon\b/.test(closed));
assert.ok(closed.includes('aria-pressed="false"'));
assert.ok(closed.includes('Claude Code') && closed.includes('Codex'));
const claudeOpen = assistantsRailHtml({ active: 'claude' });
assert.ok(/class="[^"]*\bon\b/.test(claudeOpen));
assert.ok(claudeOpen.includes('--studio-brand: #d97757'));
assert.ok(claudeOpen.includes('aria-pressed="true"'));

// The picker: both assistants by name, each with its chord.
const items = assistantPickItems({ active: undefined, capabilities: ['claude', 'codex'], mac: false });
assert.deepStrictEqual(items.map(item => [item.key, item.label, item.description]), [
    ['claude', 'Claude Code', 'Ctrl+Alt+K'],
    ['codex', 'Codex', 'Ctrl+Alt+X'],
]);
assert.ok(items.every(item => item.detail === undefined));
assert.deepStrictEqual(
    assistantPickItems({ active: undefined, capabilities: undefined, mac: true }).map(item => item.description),
    ['⌥⌘K', '⌥⌘X'],
);
// The open one says that picking it closes it.
const withCodex = assistantPickItems({ active: 'codex', capabilities: ['claude', 'codex'], mac: false });
assert.strictEqual(withCodex.find(item => item.key === 'codex').detail, 'Open now: pick it to close it');
assert.strictEqual(withCodex.find(item => item.key === 'claude').detail, undefined);
// Only what the surface in front can serve.
assert.deepStrictEqual(
    assistantPickItems({ active: undefined, capabilities: ['comments', 'codex'], mac: false }).map(item => item.key),
    ['codex'],
);
// Every assistant the slot knows is offered: none is left without a way in.
assert.deepStrictEqual(
    assistantPickItems({ active: undefined, capabilities: undefined, mac: false }).map(item => item.key),
    SLOT_APP_ENTRIES.map(entry => entry.key),
);

// The column goes under the tools, not under the Studio view at the foot.
const rect = (top, height = 32) => ({ top, bottom: top + height, height });
assert.strictEqual(topRunBottom([]), 0);
assert.strictEqual(topRunBottom([rect(0), rect(32), rect(64)]), 96);
assert.strictEqual(topRunBottom([rect(64), rect(0), rect(32), rect(800)]), 96, 'the foot tab is not counted');
assert.strictEqual(topRunBottom([rect(0), rect(36)]), 68, 'a few pixels between tabs are still one run');

// No second search on the rail, and the search key is the rail's search in every mode.
const moduleSource = fs.readFileSync(path.join(__dirname, '../src/browser/product-frontend-module.js'), 'utf8');
assert.ok(!moduleSource.includes('studio-search-rail'), 'the product Search has no rail button');
assert.ok(!moduleSource.includes('mountSearchRail'), 'nothing mounts one');
assert.ok(!/activePerspectiveId ==/.test(moduleSource), 'no per-mode search key');
assert.ok(moduleSource.includes("registerKeybinding({ command: 'search-in-workspace.open', keybinding: 'ctrlcmd+shift+f' })"));

console.log('rail: ok');
