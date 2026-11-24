/**
 * Installing a kit together with the kits it requires (ADR-0071 §5).
 *
 * The gear refuses a kit whose required kits do not apply where it is
 * installed with 400 `failed_precondition`, one `KIT_REQUIRES_KIT` violation
 * per missing kit, its slug as the subject. The screen installs those first,
 * at the same level, then the kit itself: a click on Install does what the
 * person asked instead of answering with a bare 400.
 */

import { parseProblemDetails } from '@constructor-studio/mfe-shared';

export const KIT_REQUIRES_KIT = 'KIT_REQUIRES_KIT';

/** The kits a refusal says are missing; empty for any other refusal. */
export function missingKits(error: unknown): string[] {
  return parseProblemDetails(error)
    .violations.filter((v) => v.type === KIT_REQUIRES_KIT)
    .map((v) => v.subject)
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

/**
 * Install `slug` with `install`; where the gear names kits it requires,
 * install those first (and theirs, a few levels deep), then `slug` again.
 * Returns the slugs installed on the way, in order, `slug` last. A refusal
 * of any other kind, or a cycle, is thrown as it came.
 */
export async function installWithRequired(
  slug: string,
  install: (slug: string) => Promise<unknown>,
  seen: Set<string> = new Set([slug]),
  depth = 0
): Promise<string[]> {
  try {
    await install(slug);
    return [slug];
  } catch (error) {
    const missing = missingKits(error);
    if (missing.length === 0 || depth >= 4 || missing.some((m) => seen.has(m))) throw error;
    const done: string[] = [];
    for (const kit of missing) {
      seen.add(kit);
      done.push(...(await installWithRequired(kit, install, seen, depth + 1)));
    }
    await install(slug);
    return [...done, slug];
  }
}
