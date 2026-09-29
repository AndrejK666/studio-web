// Constructor Studio: close a product's `sources = [...]` list with a comma, so
// the engine can append to it.
//
// **A workaround for an engine defect, to be removed when the pin carries the
// fix** -- https://github.com/MikeFalcon77/gearbox/issues/1. `product/create`
// writes the sources one per line and joins them with `,\n`, so the last one
// has no trailing comma (`render_product_template`, gearbox-gdl
// `edit_call.rs`). `add_source` then appends through `insert_entry`
// (`edit.rs`), which for a multi-line list writes `<indent><entry>,\n` in front
// of the closing bracket without adding the comma the previous entry lacks. The
// result is two entries with nothing between them, and every later read of the
// product fails: `GBX0101 Parse error: unexpected identifier 'source', expected
// symbol ']'`. Every product the New Product wizard writes has that shape, so
// Create Gear's "add it to the product" broke each one. Still so at 55f7015.
//
// The edit here is the one a person would make by hand: a comma after the last
// entry of a multi-line list. It changes no value -- a trailing comma is
// allowed in any GDL list -- and the caller re-reads the product before and
// after to make sure of it (`GearboxServiceImpl.closeSourcesListFor`).

/** Where `sources = [ ... ]` is, by offsets into the text. */
interface ListSpan {
  /** The offset of `[`. */
  readonly open: number;
  /** The offset of the matching `]`. */
  readonly close: number;
  /** The offset just past the last character of the last entry, or -1 when empty. */
  readonly lastEntryEnd: number;
  /** The last significant character before `]`: `,`, `[`, or the end of an entry. */
  readonly lastSignificant: string;
}

/**
 * `text` with the `sources` list closed by a trailing comma, or `undefined`
 * when there is nothing to change: no `sources` list, an empty one, one that
 * already ends with a comma, or a one-line list (the engine appends `, entry`
 * to those, which is correct as written).
 */
export function closeSourcesList(text: string): string | undefined {
  const span = findSourcesList(text);
  if (span === undefined) return undefined;
  if (span.lastSignificant === "," || span.lastSignificant === "[" || span.lastEntryEnd < 0) {
    return undefined;
  }
  if (!text.slice(span.open, span.close).includes("\n")) return undefined;
  return `${text.slice(0, span.lastEntryEnd)},${text.slice(span.lastEntryEnd)}`;
}

/** Whether the product text needs `closeSourcesList` before a source is appended. */
export function sourcesListNeedsComma(text: string): boolean {
  return closeSourcesList(text) !== undefined;
}

/**
 * Find the first `sources = [` outside strings and comments, and its matching
 * bracket. Brackets inside strings and comments are skipped, and nested
 * `(...)`, `[...]` and `{...}` in the entries are tracked, so `path("a[b]")` or
 * a `# ]` comment cannot end the list early.
 */
function findSourcesList(text: string): ListSpan | undefined {
  let i = 0;
  const n = text.length;
  let open = -1;
  // Before `sources` is found: scan for the identifier at a token boundary.
  while (i < n) {
    const skipped = skipTrivia(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text.charAt(i);
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(text.charAt(j))) j++;
      const word = text.slice(i, j);
      if (word === "sources") {
        let k = skipBlanks(text, j);
        if (text.charAt(k) === "=" && text.charAt(k + 1) !== "=") {
          k = skipBlanks(text, k + 1);
          if (text.charAt(k) === "[") {
            open = k;
            break;
          }
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  if (open < 0) return undefined;

  // Inside the list: find its `]`, remembering the last significant character
  // at the list's own depth.
  let depth = 0;
  let lastSignificant = "[";
  let lastEntryEnd = -1;
  i = open + 1;
  while (i < n) {
    const skipped = skipTrivia(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text.charAt(i);
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      if (depth === 0) {
        lastSignificant = '"';
        lastEntryEnd = i;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        if (c !== "]") return undefined;
        return { open, close: i, lastEntryEnd, lastSignificant };
      }
      depth--;
      i++;
      if (depth === 0) {
        lastSignificant = c;
        lastEntryEnd = i;
      }
      continue;
    }
    if (depth === 0) {
      lastSignificant = c;
      // A comma separates; it is not the end of an entry.
      if (c !== ",") lastEntryEnd = i + 1;
    }
    i++;
  }
  return undefined;
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

function skipBlanks(text: string, i: number): number {
  while (i < text.length && /\s/.test(text.charAt(i))) i++;
  return i;
}

/** Past whitespace and `#` comments, or `i` itself when neither starts here. */
function skipTrivia(text: string, i: number): number {
  let j = i;
  while (j < text.length) {
    if (/\s/.test(text.charAt(j))) {
      j++;
    } else if (text.charAt(j) === "#") {
      while (j < text.length && text.charAt(j) !== "\n") j++;
    } else {
      break;
    }
  }
  return j;
}

/** Past a string literal starting at `i`: single, double, or triple quoted. */
function skipString(text: string, i: number): number {
  const quote = text.charAt(i);
  const triple = text.startsWith(quote.repeat(3), i);
  let j = i + (triple ? 3 : 1);
  while (j < text.length) {
    if (text.charAt(j) === "\\") {
      j += 2;
      continue;
    }
    if (triple) {
      if (text.startsWith(quote.repeat(3), j)) return j + 3;
    } else if (text.charAt(j) === quote) {
      return j + 1;
    } else if (text.charAt(j) === "\n") {
      return j;
    }
    j++;
  }
  return j;
}
