/**
 * Retired kit slugs and what they resolve to (ADR-0071 §8), the backend's
 * alias table (`studio-backend/src/kit_registry/aliases.rs`) as the portal
 * reads it for one release: a screen, a link or an Inbox row that still names
 * a retired slug (a kit bundle built before the merge, a stored preference)
 * is shown where every kit it resolves to is installed; one that went to the
 * shell always shows.
 *
 * Step 7 (#1089) removes this table with the backend's, one release after
 * the merge reached every environment (`kitAliases.test.ts` lists it).
 */

/** Retired slug → the kits it resolves to (empty: the shell's now). */
export const KIT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'project-issues': ['project-domain-model', 'project-git'],
  'project-activity': ['project-git', 'project-lifecycle'],
  'product-releases': ['project-product', 'delivery'],
  'org-infrastructure': ['delivery'],
};

/** What `slug` resolves to when it is retired; `null` for a current slug. */
export function resolveKit(slug: string): readonly string[] | null {
  return Object.prototype.hasOwnProperty.call(KIT_ALIASES, slug) ? KIT_ALIASES[slug] : null;
}

/** Whether the kit `slug` (current or retired) is installed among `installed`. */
export function kitIn(installed: { has(slug: string): boolean }, slug: string): boolean {
  if (installed.has(slug)) return true;
  const to = resolveKit(slug);
  return to !== null && to.every((k) => installed.has(k));
}
