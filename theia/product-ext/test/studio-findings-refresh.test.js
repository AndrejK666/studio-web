/*
 * Studio's findings handed to an open document, and the load they start.
 *
 * WHY THIS EXISTS. A dev session ran out of memory soon after the editor began
 * taking Studio's findings (#594–#601), and the first suspect was a refresh
 * loop: setStudioFindings() starts refreshQuality(), whose `finally` repaints
 * the slot cluster and, when a hand-over arrived mid-load, starts itself once
 * more. Either half going wrong — a repaint that re-enters, a flag that is never
 * cleared — reads every report on disk again and again, forever, and nothing on
 * screen says so. These cases count the loads: one per hand-over, at most one
 * more for a hand-over that arrived while a load was in flight, however many
 * hand-overs arrived during it.
 *
 * HOW. The widget cannot be constructed here — it is a Lumino Widget wrapping a
 * live TipTap editor — but the module does load under jsdom (the stubs below are
 * the ones blocks-toolbar.test.js needs), so the real methods are called on an
 * object made from the real prototype, with a fake quality store that counts
 * what it is asked. Nothing in the product code is reimplemented here: if
 * setStudioFindings or refreshQuality change, these cases see the change.
 *
 * Run: `node test/studio-findings-refresh.test.js`.
 */

const assert = require('assert');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'DOMParser', 'navigator', 'Element', 'HTMLElement',
    'customElements', 'getComputedStyle', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent',
    'CustomEvent', 'localStorage']) {
    if (dom.window[k]) { global[k] = dom.window[k]; }
}
global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.DragEvent = class DragEvent extends dom.window.Event {};
global.ClipboardEvent = class ClipboardEvent extends dom.window.Event {};

const { MarkdownEditorWidget } = require('../src/browser/markdown-editor');
const studioQuality = require('../src/browser/studio-quality');
const URI = require('@theia/core/lib/common/uri').default;

// The per-hand-over console line is the product's diagnostics, not this test's.
const realInfo = console.info;
console.info = () => {};

const ROOT = 'file:///workspace/studio-web';

/** A purpose verdict with one placed finding, as the Analyze panel hands it. */
function purposeVerdict(section = '8. The config read gets a cache') {
    return {
        detector: 'purpose',
        subject: 'node-adr19',
        recordedAt: '2026-10-01T14:09:11Z',
        details: {
            gate_passed: false,
            gate_leak_share: 0.18,
            gate_threshold: 0.05,
            findings: [{
                id: 'f1',
                rule: 'purpose.foreign_section',
                path: 'docs/adr/0019.md',
                severity: 'high',
                message: 'ADR section reads as DESIGN',
                anchor: { section, line_start: 244, line_end: 248, quote: null },
                related: [],
                evidence: [],
                confidence: 0.97
            }]
        }
    };
}

/*
 * A quality store that answers like a project with no local reports, counts
 * every call, and can hold `loadReports` open so a hand-over can arrive while
 * a load is in flight.
 */
function fakeStore() {
    const calls = { rootFor: 0, loadReports: 0, loadState: 0, loadJudgments: 0, saveLastRun: 0 };
    const held = [];
    const store = {
        calls,
        hold: false,
        /** Let every load waiting in loadReports go on. */
        release() { while (held.length) { held.shift()(); } },
        waiting() { return held.length; },
        async rootFor() { calls.rootFor++; return new URI(ROOT); },
        async loadReports() {
            calls.loadReports++;
            if (store.hold) { await new Promise(resolve => held.push(resolve)); }
            return { present: false, read: 0, skipped: 0 };
        },
        async loadState() { calls.loadState++; return {}; },
        async loadJudgments() { calls.loadJudgments++; return {}; },
        reportsForDocument() { return { bloat: undefined, purpose: undefined }; },
        async saveLastRun() { calls.saveLastRun++; }
    };
    return store;
}

let docSeq = 0;

/*
 * The smallest `this` the two methods run on: the real prototype, so every
 * method they call is the product's own, with the few that need a live DOM or
 * file service replaced by counters.
 */
function fakeWidget(store) {
    const widget = Object.create(MarkdownEditorWidget.prototype);
    Object.defineProperty(widget, 'isDisposed', { value: false, writable: true, configurable: true });
    // A fresh document per case: studio-quality's "has findings" set is module
    // state keyed by uri, and one case's findings must not leak into the next.
    widget.uri = new URI(`${ROOT}/docs/adr/00${++docSeq}.md`);
    widget.qualityStore = store;
    widget.qualityRun = { available: false };
    widget.saveState = 'saved';
    widget.rail = 'comments';
    widget.railOpen = false;
    widget.threads = [];
    widget.counts = { cluster: 0, rail: 0 };
    widget.renderSlotCluster = function () { this.counts.cluster++; };
    widget.renderRail = function () { this.counts.rail++; };
    return widget;
}

/** Let every queued promise continuation run, a few rounds deep. */
async function settle(rounds = 20) {
    for (let i = 0; i < rounds; i++) { await new Promise(resolve => setImmediate(resolve)); }
}

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
    } catch (e) {
        failures.push({ name, error: e });
    }
}

(async () => {
    await test('one hand-over is one load, and the load shows Studio\'s findings', async () => {
        const store = fakeStore();
        const w = fakeWidget(store);
        w.setStudioFindings({ verdicts: [purposeVerdict()], paths: ['docs/adr/0019.md'] });
        await settle();
        assert.strictEqual(store.calls.loadReports, 1);
        assert.strictEqual(w.qualityLoading, false);
        assert.strictEqual(w.qualityLoaded, true);
        assert.strictEqual(w.qualityRefreshAgain, undefined, 'no second load asked for');
        assert.strictEqual(w.qualityFindings.length, 1, 'the purpose violation became a card');
        assert.strictEqual(w.qualityMissing, undefined);
        // Studio's findings are shown, never written back into the checkout.
        assert.strictEqual(store.calls.saveLastRun, 0);
    });

    await test('a hand-over during a load asks for exactly one more, and it happens', async () => {
        const store = fakeStore();
        store.hold = true;
        const w = fakeWidget(store);
        w.setStudioFindings({ verdicts: [purposeVerdict('A')], paths: [] });
        await settle();
        assert.strictEqual(store.waiting(), 1, 'the first load is in flight');
        w.setStudioFindings({ verdicts: [purposeVerdict('B')], paths: [] });
        assert.strictEqual(w.qualityRefreshAgain, true);
        assert.strictEqual(store.calls.loadReports, 1, 'no second load started beside the first');
        store.hold = false;
        store.release();
        await settle();
        assert.strictEqual(store.calls.loadReports, 2, 'the follow-up load ran, once');
        assert.strictEqual(w.qualityRefreshAgain, false);
        assert.strictEqual(w.qualityLoading, false);
        // And it read the LATER hand-over, which is why it exists.
        assert.strictEqual(w.qualityFindings[0].anchors[0].section, 'B');
    });

    await test('ten hand-overs during one load still cost one follow-up load', async () => {
        const store = fakeStore();
        store.hold = true;
        const w = fakeWidget(store);
        w.setStudioFindings({ verdicts: [purposeVerdict()], paths: [] });
        await settle();
        for (let i = 0; i < 10; i++) { w.setStudioFindings({ verdicts: [purposeVerdict(`S${i}`)], paths: [] }); }
        store.hold = false;
        store.release();
        await settle();
        assert.strictEqual(store.calls.loadReports, 2);
        assert.strictEqual(w.qualityFindings[0].anchors[0].section, 'S9');
    });

    await test('the load settles: nothing more is read once the widget is idle', async () => {
        const store = fakeStore();
        const w = fakeWidget(store);
        w.setStudioFindings({ verdicts: [purposeVerdict()], paths: [] });
        await settle();
        const after = { ...store.calls };
        await settle(50);
        assert.deepStrictEqual(store.calls, after, 'a finished load starts no other');
    });

    await test('every load ends by repainting the cluster, including one that failed', async () => {
        const store = fakeStore();
        store.loadReports = async () => { store.calls.loadReports++; throw new Error('malformed report'); };
        const w = fakeWidget(store);
        const realWarn = console.warn;
        console.warn = () => {};  // the expected "could not read the run" line
        w.setStudioFindings({ verdicts: [purposeVerdict()], paths: [] });
        await settle();
        console.warn = realWarn;
        assert.strictEqual(store.calls.loadReports, 1, 'a failure is not retried in a loop');
        assert.strictEqual(w.qualityLoading, false, 'the flag is cleared on the way out');
        assert.strictEqual(w.qualityError, 'malformed report');
        // One paint from the hand-over itself, one from the load's `finally`.
        assert.strictEqual(w.counts.cluster, 2);
    });

    await test('a disposed widget is not repainted and does not load again', async () => {
        const store = fakeStore();
        store.hold = true;
        const w = fakeWidget(store);
        w.setStudioFindings({ verdicts: [purposeVerdict()], paths: [] });
        await settle();
        w.setStudioFindings({ verdicts: [purposeVerdict('B')], paths: [] });
        const painted = w.counts.cluster;
        w.isDisposed = true;
        store.hold = false;
        store.release();
        await settle();
        assert.strictEqual(store.calls.loadReports, 1, 'no follow-up load for a closed document');
        assert.strictEqual(w.counts.cluster, painted);
    });

    await test('no quality store: a hand-over loads nothing and throws nothing', async () => {
        const w = fakeWidget(undefined);
        w.setStudioFindings({ verdicts: [purposeVerdict()], paths: [] });
        await settle();
        assert.strictEqual(w.qualityLoading, undefined);
    });

    await test('the Quality destination follows the findings handed over', async () => {
        const w = fakeWidget(fakeStore());
        assert.strictEqual(w.qualityAvailable(), false, 'nothing yet');
        assert.ok(!w.slotCapabilities().includes('quality'));
        assert.strictEqual(w.slotHints().quality, 'No findings for this document yet');

        w.setStudioFindings({ verdicts: [purposeVerdict()], paths: [] });
        assert.strictEqual(studioQuality.hasFindings(w.uri), true);
        assert.strictEqual(w.qualityAvailable(), true);
        // Fourth, after the three document destinations — where the strip draws it.
        assert.deepStrictEqual(w.slotCapabilities(), ['comments', 'changes', 'history', 'quality', 'claude', 'codex']);
        await settle();

        // An empty list clears them: the button greys out again.
        w.setStudioFindings({ verdicts: [], paths: [] });
        assert.strictEqual(w.studioQuality, undefined);
        assert.strictEqual(studioQuality.hasFindings(w.uri), false);
        await settle();
        assert.strictEqual(w.qualityAvailable(), false, 'the rail emptied too');
    });

    await test('verdicts recorded before findings were kept do not light the button', async () => {
        const w = fakeWidget(fakeStore());
        w.setStudioFindings({ verdicts: [{ detector: 'purpose', details: { gate_passed: true } }], paths: [] });
        assert.ok(w.studioQuality, 'Studio did look');
        assert.strictEqual(w.studioQuality.findings.length, 0);
        assert.strictEqual(studioQuality.hasFindings(w.uri), false);
        await settle();
        assert.strictEqual(w.qualityAvailable(), false);
    });

    await test('the hand-over keeps the gate numbers and the paths Studio named', async () => {
        const w = fakeWidget(fakeStore());
        w.setStudioFindings({ verdicts: [purposeVerdict()], paths: ['docs/adr/0019.md'] });
        assert.deepStrictEqual(w.studioQuality.gate, { passed: false, leakShare: 0.18, threshold: 0.05 });
        assert.deepStrictEqual(w.studioQuality.paths, ['docs/adr/0019.md']);
        assert.strictEqual(w.studioQuality.producedAt, '2026-10-01T14:09:11Z');
        // Paths that are not a list are none, not a crash later in the load.
        w.setStudioFindings({ verdicts: [purposeVerdict()], paths: 'docs/adr/0019.md' });
        assert.deepStrictEqual(w.studioQuality.paths, []);
        await settle();
    });

    console.info = realInfo;
    if (failures.length) {
        console.error(failures.length + ' failing, ' + passed + ' passing\n');
        for (const f of failures) {
            console.error('FAIL ' + f.name);
            console.error('  ' + (f.error && f.error.stack ? f.error.stack : f.error));
        }
        process.exit(1);
    }
    console.log('studio-findings-refresh: ' + passed + ' passing');
})();
