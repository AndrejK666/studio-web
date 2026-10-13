/*
 * Writing hints: requirements written so one reading is the only reading.
 *
 * WHAT THIS IS. Three checks on the sentences of a document that state a
 * requirement, after the writing rules of ASD-STE100 (Simplified Technical
 * English), in Studio's own words -- the standard's text and dictionary are
 * ASD's and are not reproduced here (docs/project-and-product.md, "The
 * project's words"):
 *
 *   writing.long_sentence     more than 20 words in one requirement;
 *   writing.two_requirements  two requirement verbs in one sentence;
 *   writing.no_actor          a passive requirement that names no actor.
 *
 * A fourth rule of the proposal, a run of more than three nouns, is left out:
 * telling a noun from a verb needs a part-of-speech reading this module does
 * not have, and a guess underlines ordinary prose.
 *
 * WHY HINTS AND NOT FINDINGS. The domain model's calibration dropped its one
 * writing rule (`constraint.vague`): nothing it raised survived review. These
 * are advice to the person writing, so they live in the editor only -- never in
 * the project's findings, its state, or a gate -- and a project can turn them
 * off on the Project page. Specs are read as written.
 *
 * WHICH SENTENCES. Only the ones with a requirement verb (shall, must, should,
 * "is required to"). Descriptions, headings and code are not requirements, and
 * holding them to a requirement's length would underline half of any design
 * document.
 *
 * WHY DECORATIONS. As quality-marks.js argues: a decoration is a view-layer
 * overlay, so nothing enters the document, the Markdown or an undo step.
 */

const { Extension } = require('@tiptap/core');
const { Plugin, PluginKey } = require('@tiptap/pm/state');
const { Decoration, DecorationSet } = require('@tiptap/pm/view');

const writingHintsKey = new PluginKey('studio-writing-hints');

/** STE's limit for an instruction; a requirement is one. */
const MAX_WORDS = 20;

const REQUIREMENT_VERB = /\b(shall|must|should|(?:is|are) required to)\b/gi;

/*
 * Abbreviations whose full stop ends no sentence. Lower-cased, without the
 * final stop. A sentence split in the wrong place only shortens a sentence,
 * so the list is the common ones, not every one.
 */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'fig', 'sec', 'mr', 'ms', 'dr']);

/**
 * The sentences of a block's text, as `{ start, end }` offsets into it. A full
 * stop, question or exclamation mark ends one when a space or the end follows
 * it, unless it ends an abbreviation or sits inside a number ("1.5", "v2.1").
 */
function sentences(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c !== '.' && c !== '!' && c !== '?') { continue; }
        const next = text[i + 1];
        if (next !== undefined && !/\s/.test(next)) { continue; }
        if (c === '.') {
            const word = /([A-Za-z.]+)$/.exec(text.slice(start, i));
            if (word && ABBREVIATIONS.has(word[1].toLowerCase())) { continue; }
        }
        push(out, text, start, i + 1);
        start = i + 1;
    }
    push(out, text, start, text.length);
    return out;
}

function push(out, text, from, to) {
    while (from < to && /\s/.test(text[from])) { from++; }
    while (to > from && /\s/.test(text[to - 1])) { to--; }
    if (to > from) { out.push({ start: from, end: to }); }
}

function words(text) {
    return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || [];
}

/*
 * A passive requirement with no actor: "shall be stored", "must be validated",
 * "is required to be sent" -- a requirement verb, `be`, and a past participle,
 * with no "by" after it naming who. The participle test is the regular "-ed"
 * and "-en" forms plus the irregular ones requirements actually use.
 */
const IRREGULAR = 'built|kept|sent|set|shown|known|held|made|read|run|written|given|taken|found|done|put|left|met|paid|sold|told|bound|brought|thrown|chosen|drawn|hidden|withdrawn|overridden';
const PASSIVE = new RegExp(
    String.raw`\b(?:shall|must|should|(?:is|are) required to)\s+(?:not\s+|also\s+|always\s+|only\s+)*be\s+(?:\w+ly\s+)?((?:\w+(?:ed|en))|${IRREGULAR})\b`,
    'gi'
);

/**
 * Every hint in one block's text: `{ rule, from, to, message }`, offsets into
 * `text`. Pure, so the rules are tested without an editor.
 */
function hintsInText(text) {
    const out = [];
    for (const s of sentences(text)) {
        const sentence = text.slice(s.start, s.end);
        const verbs = [...sentence.matchAll(REQUIREMENT_VERB)];
        if (verbs.length === 0) { continue; }

        const count = words(sentence).length;
        if (count > MAX_WORDS) {
            out.push({
                rule: 'writing.long_sentence',
                from: s.start,
                to: s.end,
                message: `${count} words. A requirement of ${MAX_WORDS} words or fewer has one reading; split it, or move the detail into a list.`
            });
        }
        if (verbs.length > 1) {
            const second = verbs[1];
            out.push({
                rule: 'writing.two_requirements',
                from: s.start + second.index,
                to: s.start + second.index + second[0].length,
                message: 'A second requirement in the same sentence. One requirement per sentence can be tested, traced and decided on its own.'
            });
        }
        for (const m of sentence.matchAll(PASSIVE)) {
            const after = sentence.slice(m.index + m[0].length);
            if (/^\s+by\b/i.test(after)) { continue; }
            out.push({
                rule: 'writing.no_actor',
                from: s.start + m.index,
                to: s.start + m.index + m[0].length,
                message: 'Who does this? A requirement in the passive names no actor; say which component or person does it.'
            });
        }
    }
    return out;
}

/** Blocks whose text is not prose a requirement is written in. */
const SKIPPED = new Set(['codeBlock', 'heading', 'mathBlock']);

/**
 * Every hint in a document, as `{ from, to, rule, message }` document
 * positions. A leaf inside a block (an image, a mention) counts as one
 * character, so positions after it stay where the text is.
 */
function hintsInDoc(doc) {
    const out = [];
    doc.descendants((node, pos) => {
        if (!node.isTextblock) { return true; }
        if (SKIPPED.has(node.type.name)) { return false; }
        const at = [];
        let text = '';
        node.forEach((child, offset) => {
            const start = pos + 1 + offset;
            if (child.isText) {
                for (let i = 0; i < child.text.length; i++) { at.push(start + i); }
                text += child.text;
            } else {
                at.push(start);
                text += '￼';
            }
        });
        at.push(pos + 1 + node.content.size);
        for (const hint of hintsInText(text)) {
            out.push({ rule: hint.rule, message: hint.message, from: at[hint.from], to: at[hint.to] });
        }
        return false;
    });
    return out;
}

function buildDecorations(doc, enabled) {
    if (!enabled) { return DecorationSet.empty; }
    return DecorationSet.create(doc, hintsInDoc(doc)
        .filter(h => h.to > h.from)
        .map(h => Decoration.inline(h.from, h.to, {
            class: 'studio-writing-hint',
            'data-writing-rule': h.rule,
            title: h.message
        })));
}

/**
 * The extension. `isEnabled` is asked on every rebuild, so the Project page's
 * switch reaches an open document through `refreshWritingHints` without the
 * plugin learning where the setting lives.
 */
function writingHintsExtension(isEnabled) {
    return Extension.create({
        name: 'studioWritingHints',
        addProseMirrorPlugins() {
            return [new Plugin({
                key: writingHintsKey,
                state: {
                    init(_, state) { return buildDecorations(state.doc, isEnabled()); },
                    apply(tr, value, oldState, newState) {
                        // Unlike a finding, a hint is about the text as it is
                        // now, so an edit re-reads the document; a selection
                        // change does not.
                        if (!tr.docChanged && !tr.getMeta(writingHintsKey)) { return value; }
                        return buildDecorations(newState.doc, isEnabled());
                    }
                },
                props: {
                    decorations(state) { return writingHintsKey.getState(state); }
                }
            })];
        }
    });
}

/** Rebuild the hints without editing the document: the setting changed. */
function refreshWritingHints(editor) {
    if (!editor || !editor.view) { return; }
    const tr = editor.view.state.tr;
    tr.setMeta(writingHintsKey, 'refresh');
    tr.setMeta('addToHistory', false);
    tr.setMeta('studio-internal', true);
    editor.view.dispatch(tr);
}

/*
 * Quieter than a finding on purpose: a finding is something to decide, a hint
 * is something to consider. A thin dotted underline in the line colour, not the
 * accent quality-marks.js uses, and no fill -- comment marks own fill.
 */
const WRITING_HINTS_CSS = `
.studio-writing-hint {
  text-decoration-line: underline;
  text-decoration-style: dotted;
  text-decoration-color: var(--studio-muted);
  text-decoration-thickness: 1px;
  text-underline-offset: 4px;
  cursor: help;
}
`;

module.exports = {
    writingHintsExtension,
    refreshWritingHints,
    hintsInText,
    hintsInDoc,
    sentences,
    MAX_WORDS,
    WRITING_HINTS_CSS
};
