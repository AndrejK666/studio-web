import type { DataGridLoadContext } from '@gears-frontx/ui-kit';

/** Where DataGrid's text-search plugin puts its value in `DataGridLoadContext.filters`, its default key. */
export const TEXT_SEARCH_FILTER_KEY = 'textSearch';

/**
 * The value a tag group filter holds: the kit hands a list, also in `radio` mode,
 * and a stored value can have any shape, so anything but a list of strings reads as none.
 */
export function tagGroupChoice(state: { value?: unknown } | undefined): string | null {
  const value = state?.value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * Every string a list filter (a checkbox group, a tag group) holds. A stored
 * value can have any shape, so anything but strings is dropped.
 */
export function listChoices(state: { value?: unknown } | undefined): string[] {
  const value = state?.value;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** What the text search holds, trimmed; `''` without one. */
export function searchQuery(filters: DataGridLoadContext['filters'], key = TEXT_SEARCH_FILTER_KEY): string {
  const value: unknown = filters?.[key]?.value;
  return typeof value === 'string' ? value.trim() : '';
}
