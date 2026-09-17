/*
 * Pointing at something that was rendered, in a way that survives re-rendering.
 *
 * A comment on a paragraph of Markdown anchors to the words it quotes
 * (comment-log.js: quote plus occurrence). A comment on a rendered THING —
 * a heading, a table, an image, a diagram — has no words to quote, and
 * requirement 22 is exactly that case: "attach a comment to a rendered heading,
 * table, image, chart, diagram, slide element, or other eligible component
 * without selecting text".
 *
 * So the anchor is the element's position in the tree.
 *
 * # Why a child-index path and not a CSS selector
 *
 * Both surfaces that render a document INJECT nodes into it — the HTML viewer
 * adds thread panels, the Markdown editor adds markers and overlays. A selector
 * like `:nth-of-type(3)` counts those, so every anchor in the document silently
 * re-points the moment a panel opens. The walker below skips anything marked as
 * injected, so the path describes the DOCUMENT rather than the document plus
 * whatever the surface is currently showing.
 *
 * An id-based selector fails differently and worse: rendered Markdown has no
 * ids, and the ids an HTML page does have are the author's to change.
 *
 * # What it does not promise
 *
 * The path is stable against re-rendering and against injected chrome. It is
 * NOT stable against editing: insert a paragraph above a table and the table's
 * path changes, exactly as a quoted sentence moves when the sentence is
 * rewritten. That is why `describe` and `snippet` are stored beside the path —
 * not to find the element, but so a surface can say WHAT was lost when the path
 * no longer resolves, rather than dropping the thread or silently attaching it
 * to whatever now sits in that position. Requirement 22 asks for exactly that:
 * "flagged for reattachment rather than moved".
 *
 * # Why this module exists
 *
 * It was written inside `html-viewer.js`, where it worked and where it could
 * only ever serve HTML pages. The rich Markdown surface needs the same thing
 * and must not grow a second, subtly different copy — two anchoring models
 * would disagree about what "the third child" means the first time one of them
 * learned to skip a node the other did not.
 *
 * The root is a parameter rather than `document.body`, which is the only change
 * the extraction needed: an HTML page anchors within its body, and an editor
 * anchors within its own content element.
 */

/** Marks nodes a surface injected into the rendered document. */
const INJECTED = 'data-studio-injected';

/** The children that belong to the document, in order. */
function realChildren(parent) {
    return [...parent.children].filter(child => !child.hasAttribute(INJECTED));
}

/**
 * Where an element sits, as indices from `root`.
 *
 * `undefined` when the element is not inside the root, or when it is itself
 * injected chrome — neither is a thing a comment may be attached to, and
 * answering with a path that resolves to something else would be worse than
 * refusing.
 */
function pathOf(el, root) {
    if (!el || !root || el === root) { return undefined; }
    const path = [];
    let node = el;
    while (node && node !== root) {
        const parent = node.parentElement;
        if (!parent) { return undefined; }
        const index = realChildren(parent).indexOf(node);
        if (index < 0) { return undefined; }
        path.unshift(index);
        node = parent;
    }
    return node === root ? path : undefined;
}

/**
 * The element a path names, or `undefined` when the document no longer has
 * one there.
 *
 * `undefined` is the answer a caller has to handle, not an error: a document
 * is edited between the comment and the reading of it, and "the thing this was
 * about is gone" is ordinary.
 */
function resolvePath(path, root) {
    if (!root || !Array.isArray(path)) { return undefined; }
    let node = root;
    for (const index of path) {
        const kids = realChildren(node);
        if (!kids[index]) { return undefined; }
        node = kids[index];
    }
    return node === root ? undefined : node;
}

/** Enough of the element's text to recognise it in a list of threads. */
function snippetOf(el) {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

/**
 * A short name for the element, for the case where the path stops resolving.
 *
 * Deliberately structural — tag, then id or first class — rather than a
 * description of what it looked like. It is read next to the snippet, which
 * carries the meaning; this carries the shape, and the two together are what
 * lets somebody decide where a lost comment should go back.
 */
function describe(el) {
    if (!el || !el.tagName) { return ''; }
    let out = el.tagName.toLowerCase();
    if (el.id) { return out + '#' + el.id; }
    if (el.className && typeof el.className === 'string') {
        const first = el.className.trim().split(/\s+/)[0];
        if (first) { out += '.' + first; }
    }
    return out;
}

/**
 * The whole anchor for an element, as a thread stores it.
 *
 * `undefined` when the element cannot be anchored, so a caller cannot
 * accidentally store an anchor with no path in it.
 */
function anchorFor(el, root) {
    const path = pathOf(el, root);
    if (!path) { return undefined; }
    return {
        type: 'element',
        path,
        tag: el.tagName.toLowerCase(),
        describe: describe(el),
        snippet: snippetOf(el)
    };
}


/*
 * An area inside an element (requirement 23).
 *
 * "Draw a rectangular area over rendered content and attach a comment without
 * creating a screenshot. The area is stored relative to its page, slide, image
 * or canvas."
 *
 * RELATIVE IS THE WHOLE REQUIREMENT, and it means fractions rather than pixels.
 * A rectangle over the left third of a diagram has to stay over the left third
 * when the window is narrower, the font is larger, or the same document is read
 * on somebody else's screen. Pixels would put it over the middle, silently, and
 * a comment pointing at the wrong part of a picture is worse than one that
 * admits it is lost.
 *
 * WHAT IS STORED BESIDE IT is the container's aspect ratio at the moment of
 * drawing. Fractions survive a resize; they do not survive a RESHAPE — a
 * diagram that was wide and is now tall has rearranged its own contents, and
 * the same fractions now cover something else entirely. That is the case
 * requirement 23 asks to be caught: "asks for reattachment rather than silently
 * moving it when layout changes prevent reliable placement". The ratio is how
 * this tells the two apart.
 */

/** How far the shape may drift before the placement stops being trustworthy. */
const ASPECT_TOLERANCE = 0.25;

/** Clamp to the unit square: a drag can leave the element it started in. */
function unit(value) {
    return Math.min(1, Math.max(0, value));
}

/**
 * A rectangle in client coordinates, as fractions of the element's own box.
 *
 * `undefined` when the element has no box to be relative to — a collapsed or
 * hidden container gives a division by zero, and a fraction of nothing is not
 * an anchor.
 */
function areaIn(rect, box) {
    if (!rect || !box || !box.width || !box.height) { return undefined; }
    const x = unit((rect.left - box.left) / box.width);
    const y = unit((rect.top - box.top) / box.height);
    const right = unit((rect.left + rect.width - box.left) / box.width);
    const bottom = unit((rect.top + rect.height - box.top) / box.height);
    const w = right - x;
    const h = bottom - y;
    /* A drag that ends where it started is a click, not an area. Below a
     * percent of the container in either direction there is nothing a reader
     * could see highlighted anyway. */
    if (w < 0.01 || h < 0.01) { return undefined; }
    return { x, y, w, h };
}

/**
 * The whole anchor for an area: which element, where inside it, and what shape
 * that element was.
 */
function areaAnchorFor(el, root, rect, box) {
    const path = pathOf(el, root);
    if (!path) { return undefined; }
    const area = areaIn(rect, box);
    if (!area) { return undefined; }
    return {
        type: 'area',
        path,
        area,
        aspect: box.width / box.height,
        tag: el.tagName.toLowerCase(),
        describe: describe(el),
        snippet: snippetOf(el)
    };
}

/** Where the area sits now, in pixels inside the element's current box. */
function placeArea(anchor, box) {
    if (!anchor || anchor.type !== 'area' || !anchor.area || !box) { return undefined; }
    return {
        left: anchor.area.x * box.width,
        top: anchor.area.y * box.height,
        width: anchor.area.w * box.width,
        height: anchor.area.h * box.height
    };
}

/**
 * Has the container reshaped enough that the placement cannot be trusted?
 *
 * Compared as a ratio of ratios, so it does not care about size — only about
 * shape. An anchor written before this field existed has no ratio to compare
 * and is treated as placeable: an old comment is not evidence of a reshape.
 */
function aspectDrifted(anchor, box, tolerance = ASPECT_TOLERANCE) {
    if (!anchor || !anchor.aspect || !box || !box.width || !box.height) { return false; }
    const now = box.width / box.height;
    if (!Number.isFinite(now) || now <= 0) { return false; }
    const drift = Math.abs(Math.log(now / anchor.aspect));
    return drift > Math.log(1 + tolerance);
}

/** What a surface shows for an anchor whose element it can no longer find. */
function lostText(anchor) {
    if (!anchor) { return ''; }
    const shape = anchor.describe || anchor.tag || 'something';
    return anchor.snippet ? shape + ' — ' + anchor.snippet : shape;
}

module.exports = {
    INJECTED, realChildren, pathOf, resolvePath, snippetOf, describe, anchorFor, lostText,
    areaIn, areaAnchorFor, placeArea, aspectDrifted, ASPECT_TOLERANCE
};
