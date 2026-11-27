/**
 * Which documents a project's graph reads, as the setup form asks for them, and
 * the service's scope string they become (issue: the form used to take the
 * service's command-line flags as they are).
 *
 * Two layouts:
 * - **docs**: one documentation tree, every Markdown file under one directory,
 *   named by a label (`--docs-root docs --name insight .`);
 * - **gears**: a repository laid out by gears, each with its own `docs/`
 *   (`gears/a gears/b`); each gear's directory names its documents.
 */

export type Layout = 'docs' | 'gears';

export interface Documents {
  layout: Layout;
  /** docs: the directory, relative to the repository's root. */
  root: string;
  /** docs: the label its nodes and findings carry. */
  name: string;
  /** gears: the gear directories, one per line or space-separated. */
  gears: string;
}

const clean = (s: string) => s.trim().replace(/^\.?\/+|\/+$/g, '');

/** A label the service accepts: letters, digits, `.`, `_`, `-`. */
export const labelOf = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** The gear directories, in order, once each. */
export function gearList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map(clean).filter(Boolean))];
}

/** What is missing, as a translation key; null when the documents can be read. */
export function invalid(d: Documents): string | null {
  if (d.layout === 'gears') return gearList(d.gears).length ? null : 'setup_need_gears';
  if (!clean(d.root)) return 'setup_need_root';
  if (!labelOf(d.name)) return 'setup_need_name';
  return null;
}

/** The scope string the service reads (`specq`'s arguments). */
export function scopeOf(d: Documents): string {
  if (d.layout === 'gears') return gearList(d.gears).join(' ');
  return `--docs-root ${clean(d.root)} --name ${labelOf(d.name)} .`;
}

/** A scope string read back into the form (a project set up before, or by MCP). */
export function documentsOf(scope: string | undefined, fallbackName = 'docs'): Documents {
  const s = (scope ?? '').trim();
  const root = /--docs-root\s+(\S+)/.exec(s)?.[1];
  if (root || !s) {
    return { layout: 'docs', root: root ?? 'docs', name: /--name\s+(\S+)/.exec(s)?.[1] ?? fallbackName, gears: '' };
  }
  return { layout: 'gears', root: 'docs', name: fallbackName, gears: s.split(/\s+/).join('\n') };
}
