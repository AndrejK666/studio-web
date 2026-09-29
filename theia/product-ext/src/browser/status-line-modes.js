/*
 * What the bottom line keeps of Theia's own entries, per mode.
 *
 * `status-line.js` hides every entry the product does not own, and for the
 * product's reading surface that is right: a "0  0" marker count and two empty
 * boxes beside a paragraph are clutter. It was also applied to every mode,
 * which made the modes for working on code blind: no branch, no dirty or sync
 * state, no Problems count, no notification bell, no bottom-panel toggle. A
 * programmer reads exactly those at a glance, and nowhere else in the shell
 * states them continuously.
 *
 * So the cap is kept, and made per mode. Doc editing keeps the quiet line. The
 * code modes get a short, named list back, not the whole bar: each entry below
 * is one Theia contributes and one a code mode needs. Anything else a package
 * or an extension adds stays hidden until it is named here, which is the same
 * discipline the cap has always had.
 *
 * The mode is `body[data-studio-perspective]`, which the studio extension sets
 * (studio-chrome-mode.ts). Without it — a build with no studio extension — no
 * rule here matches and the line is the product's quiet one everywhere.
 */

/** The modes for working on code: Development, Full, Agent development, Building. */
const CODE_MODE_PERSPECTIVES = ['default', 'studio.full', 'studio.orca-mode', 'gearbox.product'];

/**
 * Theia's entries a code mode shows, as the ids Theia renders them under
 * (`status-bar-<entry id>`). A trailing `*` is a prefix.
 */
const CODE_MODE_STATUS_ENTRIES = [
    // Source control: the branch, dirty and sync state (`scm.status.<n>`, one
    // per command the SCM provider publishes — the git extension's branch and
    // sync), and the repository picker (`scm.change.repository`) when there is
    // more than one.
    'scm.*',
    // Errors and warnings in the project; the click opens Problems.
    'problem-marker-status',
    // The bell: where a notification goes after its toast is gone.
    'theia-notification-center',
    // Something is running (indexing, a task, an install).
    'theia-progress-status-bar-item',
    // The IDE lost its backend: the one warning that must not be silent.
    'connection-status',
    // Show or hide the bottom panel, where the terminal and Problems are.
    'bottom-panel-toggle',
    // Where the cursor is, in the file in front.
    'editor-status-cursor-position',
];

function entrySelector(entry) {
    return entry.endsWith('*')
        ? `[id^="status-bar-${entry.slice(0, -1)}"]`
        : `[id="status-bar-${entry}"]`;
}

/**
 * The rule that brings the named entries back in the code modes.
 *
 * It must outrank the blanket hide, `#theia-statusBar
 * .element:not([class*="studio-status-"])` — (1,2,0) — whichever stylesheet
 * is injected last. `body[...] #theia-statusBar .element[id...]` is (1,3,1).
 */
function codeModeStatusCss(perspectives = CODE_MODE_PERSPECTIVES, entries = CODE_MODE_STATUS_ENTRIES) {
    const selectors = [];
    for (const perspective of perspectives) {
        for (const entry of entries) {
            selectors.push(`body[data-studio-perspective="${perspective}"] #theia-statusBar .element${entrySelector(entry)}`);
        }
    }
    return selectors.length ? selectors.join(',\n') + ' { display: flex !important; }\n' : '';
}

module.exports = { CODE_MODE_PERSPECTIVES, CODE_MODE_STATUS_ENTRIES, codeModeStatusCss };
