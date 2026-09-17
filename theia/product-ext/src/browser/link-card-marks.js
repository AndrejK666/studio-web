/*
 * Drawing the card for a recognised link (requirement 21).
 *
 * `link-cards.js` decides WHAT a link is; this draws it. Split for the reason
 * every other pair in this package is split — the deciding is pure and testable
 * in node, and the drawing needs an editor.
 *
 * # A decoration, never a node
 *
 * suggest-marks.js argues this at length and quality-marks.js repeats it: a
 * decoration is a VIEW-LAYER overlay, so nothing enters the document model,
 * nothing reaches the Markdown serialiser, and nothing lands in an undo step. A
 * card that lived in the document would have to be excluded from every
 * serialisation path, and one missed path writes a rendering artefact into
 * somebody's file.
 *
 * # Chrome around the link, not instead of it
 *
 * The obvious card replaces the URL with a title. This does not, and the reason
 * is requirement 21's own words: a failing plugin must "preserve the original
 * resource" and "not block editing". A replaced URL is a URL a person cannot
 * edit — they would have to delete the card to fix a typo in the link it is
 * made of.
 *
 * So the paragraph keeps its link, exactly as written, and gains a border and a
 * line above it saying what the link points at. The fallback is then not a code
 * path at all: an unrecognised link is a paragraph without the decoration,
 * which is what it already was.
 *
 * # Rebuilt rather than mapped
 *
 * quality-marks.js maps its decorations through each step because its ranges
 * come from a scan that ran earlier. These come from the document itself, so
 * mapping would preserve a card for a link that has just been edited into
 * something else. Rebuilding walks the top-level blocks — cheap, and always
 * true — and only on a transaction that actually changed the document.
 */

const { Extension } = require('@tiptap/core');
const { Plugin, PluginKey } = require('@tiptap/pm/state');
const { Decoration, DecorationSet } = require('@tiptap/pm/view');
const { recognise, isBareLink } = require('./link-cards');

const linkCardsKey = new PluginKey('studioLinkCards');

/** Looks enough like an address to try: the recogniser refuses the rest. */
const LOOKS_LIKE_URL = /^https?:\/\/\S+$/i;

/**
 * The href a paragraph is about, when it is about exactly one.
 *
 * Either a link mark covering the whole of it, or a bare address the editor has
 * not marked up. `undefined` for a paragraph that says anything else — a link
 * inside a sentence is already carrying its own words.
 */
function soleLinkIn(node) {
    const text = (node.textContent || '').trim();
    if (!text) { return undefined; }
    let href;
    let marked = 0;
    node.descendants(child => {
        if (!child.isText) { return; }
        const link = child.marks.find(mark => mark.type.name === 'link');
        if (!link) { return; }
        href = href || (link.attrs && link.attrs.href);
        marked += child.text ? child.text.length : 0;
    });
    if (href) {
        // The mark has to cover the paragraph: "see <link>" is a sentence.
        return marked >= text.length && isBareLink(text, text) ? href : undefined;
    }
    return LOOKS_LIKE_URL.test(text) ? text : undefined;
}

/** One line of chrome: what it is, where it lives, which one. */
function cardLine(card) {
    return [card.badge, card.subtitle, card.title].filter(Boolean).join(' · ');
}

function buildDecorations(doc, enabled) {
    if (!enabled) { return DecorationSet.empty; }
    const decorations = [];
    doc.forEach((node, offset) => {
        if (node.type.name !== 'paragraph') { return; }
        const href = soleLinkIn(node);
        if (!href) { return; }
        let card;
        try {
            card = recognise(href, Array.isArray(enabled) ? enabled : undefined);
        } catch (error) {
            // Belt and braces over the recogniser's own guard: a throw here
            // would take the whole decoration set with it, and with it every
            // other card in the document.
            console.warn('[studio] link card failed', error);
            card = undefined;
        }
        if (!card) { return; }
        decorations.push(Decoration.node(offset, offset + node.nodeSize, {
            class: 'studio-link-card',
            'data-card': cardLine(card),
            'data-card-kind': card.kind
        }));
    });
    return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * @param getEnabled answers the kinds this project allows: `false` when the
 *        feature is off, `true` for all of them, or an array of kind names.
 */
function linkCardExtension(getEnabled) {
    return Extension.create({
        name: 'studioLinkCards',
        addProseMirrorPlugins() {
            return [new Plugin({
                key: linkCardsKey,
                state: {
                    init(_, state) { return buildDecorations(state.doc, getEnabled()); },
                    apply(tr, value, _oldState, newState) {
                        // A selection-only transaction — every arrow key — must
                        // not rebuild anything.
                        if (!tr.docChanged && !tr.getMeta(linkCardsKey)) { return value; }
                        return buildDecorations(newState.doc, getEnabled());
                    }
                },
                props: {
                    decorations(state) { return linkCardsKey.getState(state); }
                }
            })];
        }
    });
}

/** Ask for a rebuild when the project's settings changed under the editor. */
function refreshLinkCards(editor) {
    if (!editor) { return; }
    editor.view.dispatch(editor.state.tr
        .setMeta(linkCardsKey, true)
        .setMeta('addToHistory', false)
        .setMeta('studio-internal', true));
}

const LINK_CARD_CSS = `
/* --- a recognised link (requirement 21) ----------------------------------- *
 *
 * Chrome AROUND the link, never instead of it: the address stays visible and
 * editable, which is what keeps "preserve the original resource" and "do not
 * block editing" true without a code path for either.
 *
 * The line above is a ::before on the paragraph, so it is not in the document,
 * not in the selection, and not in anything the serialiser walks. Copying the
 * paragraph copies the link, which is what a person meant to copy. */
.studio-link-card {
  position: relative;
  border: 1px solid var(--studio-line);
  border-radius: var(--studio-radius, 6px);
  background: var(--studio-surface);
  padding: 26px 12px 10px;
  margin: 10px 0;
}
.studio-link-card::before {
  content: attr(data-card);
  position: absolute; top: 6px; left: 12px;
  font-size: 11px; font-weight: 650; letter-spacing: 0.02em;
  color: var(--studio-muted);
}
/* The kinds are told apart by one word in that line, not by colour: four
   tinted cards in a document that already carries comments, tracked changes
   and quality marks is where the page stops being readable. */
.studio-link-card[data-card-kind="change"]::before { color: var(--studio-accent); }
`;

module.exports = {
    linkCardExtension, refreshLinkCards, buildDecorations, soleLinkIn, cardLine,
    LINK_CARD_CSS, linkCardsKey
};
