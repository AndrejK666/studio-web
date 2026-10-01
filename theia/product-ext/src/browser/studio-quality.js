/*
 * Studio's own findings about a document, as the reports this editor already
 * reads.
 *
 * WHERE THEY COME FROM. A Spec Quality run on the server — started by a source
 * sync, the Specs tab or the IDE's Analyze panel — records each document's
 * result as a `spec_finding` node, one per detector, with the findings it placed
 * in the text under `details.findings`. The Analyze panel (theia/studio) reads
 * those for the document on screen and hands them to this widget through
 * `setStudioFindings`. This editor has no Studio API of its own, on purpose: the
 * panel already has the session's Studio client and knows which binding a file
 * is.
 *
 * WHY THE REPORT SHAPES, NOT A SECOND PIPELINE. The rail, the cards, the
 * underline and "jump to" all run off `quality-scan.normalizeDocument`, which
 * takes the detectors' own `bloat` and `purpose` reports — and Spec Quality on
 * the server IS those detectors. So a server finding becomes the report entry
 * it was read from: a `purpose` gate violation, or one occurrence of a `bloat`
 * cluster. Everything after that — fingerprints, trust bands, triage, anchoring
 * by quote and section instead of by offsets the detector computed on other
 * text — is the code that already exists and is already tested.
 *
 * `leak` has no report of its own here. A leak is the same claim a purpose
 * violation makes — this section reads as another kind of document — at the
 * same granularity, so it is given as one, with its own reason.
 *
 * This file is pure: no DOM, no Theia, testable under plain node.
 */

/** A finding the server placed in a section: purpose and leak. */
function isSectionFinding(finding) {
    return finding && (finding.rule === 'purpose.foreign_section' || finding.rule === 'leak.foreign_content');
}

/** A finding the server placed on a passage: bloat. */
function isPassageFinding(finding) {
    return finding && (finding.rule === 'bloat.cross_document' || finding.rule === 'bloat.self_repeat');
}

function occurrence(file, anchor) {
    return {
        file,
        section: anchor && anchor.section ? anchor.section : undefined,
        line: anchor && Number.isFinite(anchor.line_start) ? anchor.line_start : undefined,
        line_end: anchor && Number.isFinite(anchor.line_end) ? anchor.line_end : undefined,
        // No character offsets: the service's do not match its own text (see
        // studio-backend/src/spec_quality/findings.rs). The quote is what
        // anchors a passage, found again in the live document.
        char_start: undefined,
        char_end: undefined,
        text: anchor && anchor.quote ? anchor.quote : ''
    };
}

/**
 * The `{ bloat, purpose }` pair `normalizeDocument` takes, built from the
 * server's findings for ONE document.
 *
 * `relPath` is the path this editor knows the document by (relative to its
 * root); `ownPaths` are the paths Studio may name it by (the binding's
 * repository path, `studio-doc/<id>.md`). A finding's own anchor is stamped
 * with `relPath`, so it lands on this document; a related passage keeps the
 * path Studio gave it, which is another document.
 *
 * Returns `undefined` when there is nothing to show, so the caller can tell
 * "Studio has not looked" from "Studio looked and found nothing" by whether it
 * passed any verdicts at all — see `studioReportsFor`.
 */
function studioReports(findings, relPath, ownPaths = []) {
    const own = new Set([relPath, ...ownPaths].filter(Boolean));
    const isOwn = path => !path || own.has(path);
    const violations = [];
    const clusters = [];
    const seenClusters = new Set();

    for (const finding of Array.isArray(findings) ? findings : []) {
        if (isSectionFinding(finding)) {
            const a = finding.anchor || {};
            if (!a.section) { continue; }
            violations.push({
                section: a.section,
                line_start: a.line_start,
                line_end: a.line_end,
                confidence: finding.confidence,
                reason: finding.message,
                evidence: Array.isArray(finding.evidence) ? finding.evidence : []
            });
        } else if (isPassageFinding(finding)) {
            if (!finding.anchor || !finding.anchor.quote) { continue; }
            const occurrences = [occurrence(relPath, finding.anchor)];
            for (const r of finding.related || []) {
                occurrences.push(occurrence(isOwn(r.path) ? relPath : r.path, r.anchor));
            }
            // Both copies of a passage repeated inside this document come back
            // as two findings naming each other: one cluster, not two.
            const key = occurrences.map(o => `${o.file}:${o.line}`).sort().join('|');
            if (seenClusters.has(key)) { continue; }
            seenClusters.add(key);
            clusters.push({
                source: 'lexical',
                confidence: finding.confidence,
                occurrences
            });
        }
    }
    return {
        bloat: { clusters },
        purpose: {
            gate: { passed: violations.length === 0, violations }
        }
    };
}

/**
 * Every finding in a document's recorded verdicts, flattened.
 *
 * `verdicts` are the panel's `SpecFinding`s: one per detector, each with
 * `details.findings`. A verdict recorded before the server kept findings has
 * none, and contributes nothing here rather than an invented anchor.
 */
function flattenVerdicts(verdicts) {
    const out = [];
    for (const verdict of Array.isArray(verdicts) ? verdicts : []) {
        const items = verdict && verdict.details && Array.isArray(verdict.details.findings)
            ? verdict.details.findings
            : [];
        out.push(...items);
    }
    return out;
}

/** The latest time any of these verdicts was recorded, or undefined. */
function latestRecordedAt(verdicts) {
    let latest;
    for (const verdict of Array.isArray(verdicts) ? verdicts : []) {
        const at = verdict && verdict.recordedAt;
        if (typeof at === 'string' && (!latest || at > latest)) { latest = at; }
    }
    return latest;
}

module.exports = { studioReports, flattenVerdicts, latestRecordedAt };
