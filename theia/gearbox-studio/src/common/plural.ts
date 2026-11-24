// A count and its noun, agreeing: `1 warning`, `2 warnings`. The desktop's
// text says what it counts instead of "warning(s)" -- the portal's `t.count`
// and the backend's `plural` do the same. English only, as the rest of this
// extension's text is.

/** `1 warning`, `2 warnings`: a count and its noun, agreeing. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
