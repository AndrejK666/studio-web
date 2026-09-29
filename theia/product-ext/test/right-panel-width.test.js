// node test/right-panel-width.test.js
//
// The right panel opens at a readable width for whatever is in it, not only for
// the assistants (ai-context.js: RIGHT_PANEL_MIN_WIDTH, settleRightPanelWidth).
const assert = require('assert');
const {
    RIGHT_PANEL_MIN_WIDTH, SLOT_PANEL_WIDTH, rightPanelShowing, rightPanelNeedsWidth, settleRightPanelWidth, zeroRightPanelSlot
} = require('../src/browser/ai-context.js');

global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.document = { querySelector: () => null };   // no activity bar column: the product hides it

/** A right panel holding `current` (or nothing), `width` px wide, inside a split of [main, panel]. */
function shell({ current, width, pendingUpdate }) {
    const resized = [];
    let sizes = [0.7, 0.3];
    const container = {
        node: { getBoundingClientRect: () => ({ width }) },
    };
    container.parent = {
        widgets: [{}, container],
        relativeSizes: () => [...sizes],
        setRelativeSizes: next => { sizes = next; },
    };
    return {
        resized,
        sizes: () => sizes,
        rightPanelHandler: {
            tabBar: { currentTitle: current ? { owner: { id: current } } : null },
            container,
            state: { pendingUpdate },
            resize: size => resized.push(size),
        },
    };
}

(async () => {
    // The rule, apart from the shell.
    assert.strictEqual(RIGHT_PANEL_MIN_WIDTH, 300);
    assert.strictEqual(rightPanelNeedsWidth(true, 100), true);
    assert.strictEqual(rightPanelNeedsWidth(true, 299), true);
    assert.strictEqual(rightPanelNeedsWidth(true, 300), false);      // a readable width somebody left is kept
    assert.strictEqual(rightPanelNeedsWidth(false, 0), false);       // a collapsed panel is not given a width
    assert.strictEqual(rightPanelNeedsWidth(true, undefined), false); // nothing to read, nothing decided

    // Showing means a current tab, whoever owns it -- not "an assistant".
    assert.strictEqual(rightPanelShowing(shell({ current: 'studio.orca', width: 100 })), true);
    assert.strictEqual(rightPanelShowing(shell({ current: undefined, width: 0 })), false);

    // Agents at Theia's 100px floor: given the assistant's width.
    const orca = shell({ current: 'studio.orca', width: 100 });
    assert.strictEqual(await settleRightPanelWidth(orca), true);
    assert.deepStrictEqual(orca.resized, [SLOT_PANEL_WIDTH]);

    // Source Control at 420px: left alone.
    const wide = shell({ current: 'scm-view-container', width: 420 });
    assert.strictEqual(await settleRightPanelWidth(wide), false);
    assert.deepStrictEqual(wide.resized, []);

    // An assistant revealed through revealAssistant already has 360: no second resize.
    const claude = shell({ current: 'plugin-view-container:workbench.view.extension.claude-sidebar-secondary', width: 360 });
    assert.strictEqual(await settleRightPanelWidth(claude), false);

    // Collapsed: nothing to do.
    const empty = shell({ current: undefined, width: 0 });
    assert.strictEqual(await settleRightPanelWidth(empty), false);
    assert.deepStrictEqual(empty.resized, []);

    // It waits for the expansion animation, and reads the width it ended at.
    let width = 60;
    let finish;
    const animating = shell({ current: 'gearbox.inspector', width: 0, pendingUpdate: new Promise(resolve => { finish = resolve; }) });
    animating.rightPanelHandler.container.node.getBoundingClientRect = () => ({ width });
    const settled = settleRightPanelWidth(animating);
    width = 340;          // the remembered width, reached once the animation ends
    finish();
    assert.strictEqual(await settled, false);
    assert.deepStrictEqual(animating.resized, []);

    // The slot is still given back to the document when it is empty.
    const collapsed = shell({ current: undefined, width: 0 });
    zeroRightPanelSlot(collapsed);
    assert.deepStrictEqual(collapsed.sizes(), [1, 0]);

    console.log('right-panel-width: ok');
})().catch(error => { console.error(error); process.exit(1); });
