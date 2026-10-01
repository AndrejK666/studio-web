/*
 * Studio's recorded findings, read through the editor's own quality pipeline.
 *
 * The point of studio-quality.js is that a server finding becomes the detector
 * report entry it came from, so everything after it — fingerprints, trust,
 * anchoring by quote and section — is the code that already exists. These
 * cases check that the conversion lands where that code expects: a section
 * finding as a purpose violation on THIS document, a duplicated passage as one
 * cluster whose own occurrence is this document and whose others keep their
 * paths, and that the envelope normalizeDocument builds from them has the
 * findings in it.
 *
 * Run: `node test/studio-quality.test.js`.
 */

const assert = require('node:assert');
const { studioReports, flattenVerdicts, latestRecordedAt, markFindings, hasFindings } = require('../src/browser/studio-quality');
const qualityScan = require('../src/browser/quality-scan');

// A purpose verdict exactly as the server recorded it for ADR-0019 on
// 2026-10-01, and a bloat one for ADR-0018.
const verdicts = [
    {
        detector: 'purpose',
        subject: 'node-adr19',
        recordedAt: '2026-10-01T14:09:11Z',
        details: {
            findings: [{
                id: '7742df92c8cfd7435c1c76a4b7fc2f66',
                rule: 'purpose.foreign_section',
                path: 'docs/adr/0019.md',
                severity: 'high',
                message: 'ADR section reads as DESIGN (belongs in a design doc, not a adr)',
                anchor: { section: '8. The config read gets a cache', line_start: 244, line_end: 248, quote: null },
                related: [],
                evidence: ['llm: Describes caching mechanism, generation keying, and test tripwire.'],
                confidence: 0.97
            }]
        }
    },
    {
        detector: 'leak',
        subject: 'node-adr19',
        recordedAt: '2026-10-01T14:09:05Z',
        details: {
            findings: [{
                id: 'aa',
                rule: 'leak.foreign_content',
                path: 'docs/adr/0019.md',
                severity: 'high',
                message: 'This passage reads as design, which belongs in another document type',
                anchor: { section: '7. Switching to roles', line_start: 210, line_end: 240 },
                related: [],
                evidence: ['"The writer seeds the ladder"'],
                confidence: 0.98
            }]
        }
    },
    {
        detector: 'bloat',
        subject: 'node-adr19',
        recordedAt: '2026-10-01T14:08:54Z',
        details: {
            findings: [{
                id: 'bb',
                rule: 'bloat.cross_document',
                path: 'docs/adr/0019.md',
                severity: 'medium',
                message: 'This passage also appears in 0018.md',
                anchor: { section: 'Context', line_start: 30, line_end: 31, quote: '`privilege_for` maps no resource type' },
                related: [{ path: 'docs/adr/0018.md', anchor: { line_start: 382, line_end: 385, quote: '`privilege_for` maps no resource type' } }],
                evidence: [],
                confidence: 0.72
            }]
        }
    },
    // Recorded before findings were kept: contributes nothing, invents nothing.
    { detector: 'traceability', subject: 'node-adr19', details: { references: [] } }
];

const relPath = 'api/docs/adr/0019.md';
const findings = flattenVerdicts(verdicts);
assert.strictEqual(findings.length, 3, 'one finding per placed item, none for the old verdict');
assert.strictEqual(latestRecordedAt(verdicts), '2026-10-01T14:09:11Z');

const pair = studioReports(findings, relPath, ['docs/adr/0019.md']);

// purpose and leak become violations on this document's sections.
assert.strictEqual(pair.purpose.gate.violations.length, 2);
assert.deepStrictEqual(pair.purpose.gate.violations.map(v => v.section),
    ['8. The config read gets a cache', '7. Switching to roles']);
assert.strictEqual(pair.purpose.gate.violations[0].reason,
    'ADR section reads as DESIGN (belongs in a design doc, not a adr)');
assert.strictEqual(pair.purpose.gate.passed, false);

// bloat becomes one cluster: this document's occurrence under the editor's
// path, the other copy under Studio's path for that document.
assert.strictEqual(pair.bloat.clusters.length, 1);
const [own, other] = pair.bloat.clusters[0].occurrences;
assert.strictEqual(own.file, relPath);
assert.strictEqual(own.line, 30);
assert.strictEqual(own.text, '`privilege_for` maps no resource type');
assert.strictEqual(own.char_start, undefined, 'no character offsets: the service\'s do not match its text');
assert.strictEqual(other.file, 'docs/adr/0018.md');

// Two findings naming each other inside one document are one cluster.
const repeat = (line, otherLine) => ({
    rule: 'bloat.self_repeat', severity: 'low', message: 'twice',
    anchor: { section: 'S', line_start: line, line_end: line, quote: 'same words' },
    related: [{ path: 'docs/adr/0019.md', anchor: { line_start: otherLine, line_end: otherLine, quote: 'same words' } }],
    evidence: []
});
const twice = studioReports([repeat(3, 9), repeat(9, 3)], relPath, ['docs/adr/0019.md']);
assert.strictEqual(twice.bloat.clusters.length, 1);
assert.ok(twice.bloat.clusters[0].occurrences.every(o => o.file === relPath));

// And the editor's own pipeline turns them into findings it can anchor.
const envelope = qualityScan.normalizeDocument({
    bloat: pair.bloat, purpose: pair.purpose, docPath: relPath, root: 'file:///workspace',
    runId: 'studio', producedAt: '2026-10-01T14:09:11Z'
});
assert.strictEqual(envelope.findings.length, 3);
const purposeCards = envelope.findings.filter(f => f.rule === 'purpose');
assert.strictEqual(purposeCards.length, 2);
assert.ok(purposeCards.every(f => f.anchors[0].file === relPath && f.anchors[0].granularity === 'section'));
const duplicate = envelope.findings.find(f => f.rule === 'duplicate');
assert.strictEqual(duplicate.anchors.filter(a => a.file === relPath).length, 1);
assert.ok(new Set(envelope.findings.map(f => f.fingerprint)).size === 3, 'distinct fingerprints');

// Nothing to show is nothing, not a broken report.
const empty = studioReports([], relPath);
assert.deepStrictEqual(empty.bloat.clusters, []);
assert.deepStrictEqual(empty.purpose.gate.violations, []);

// A document Studio has findings for offers the quality destination even in a
// project that never turned local signals on; clearing them takes it away.
const uri = { toString: () => 'file:///workspace/studio-web/docs/adr/0011.md' };
assert.strictEqual(hasFindings(uri), false);
markFindings(uri, true);
assert.strictEqual(hasFindings(uri), true);
assert.strictEqual(hasFindings({ toString: () => 'file:///workspace/other.md' }), false);
markFindings(uri, false);
assert.strictEqual(hasFindings(uri), false);

// The Quality button is always drawn on a document: disabled with a reason
// when it has no findings, live when it has.
const { renderDocCluster } = require('../src/browser/slot-strip');
function cluster(caps, hints) {
    const node = { innerHTML: '' };
    renderDocCluster(node, {
        uri,
        slotCapabilities: () => caps,
        slotState: () => ({}),
        slotHints: () => hints
    });
    return node.innerHTML;
}
const qualityButton = html => (html.match(/<button[^>]*data-studio-rail="quality"[^>]*>/) || [])[0];
const off = qualityButton(cluster(['comments', 'changes', 'history'], { quality: 'No findings for this document yet' }));
assert.ok(off, 'drawn without findings');
assert.ok(/aria-disabled="true"/.test(off), 'and disabled');
assert.ok(/title="No findings for this document yet"/.test(off), 'saying why');
const on = qualityButton(cluster(['comments', 'changes', 'history', 'quality']));
assert.ok(on && !/aria-disabled/.test(on), 'live with findings');

console.log('studio-quality: all cases pass');
