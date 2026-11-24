// A count and its noun, agreeing: `1 document`, `2 documents`. The desktop's
// text says what it counts instead of "document(s)" -- the portal's `t.count`
// and the backend's `plural` do the same. English only, as the rest of this
// extension's text is.

/** `1 fact`, `2 facts`: a count and its noun, agreeing. */
export function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}
