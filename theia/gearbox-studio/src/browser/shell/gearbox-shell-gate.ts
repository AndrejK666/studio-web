// Constructor Studio: whether Gearbox may arrange the shell right now.
//
// Gearbox Studio was a whole IDE of its own, so its services folded panels,
// closed screens and switched perspectives whenever what was open changed. In
// Constructor Studio it is one set of views among ours: the Workbench and
// Documents perspectives, the collab strip, Orca and the Explorer belong to
// Studio, and none of them may be folded or replaced because a product was
// opened. Every shell-arranging path in this package asks this first; it
// answers yes only while a Gearbox perspective is the active one, which the
// person chose.

import type { PerspectiveService } from "@theia/core/lib/browser/perspective-service";

/** The id prefix of the perspectives this package registers. */
export const GEARBOX_PERSPECTIVE_PREFIX = "gearbox.";

export function gearboxOwnsLayout(perspectives: PerspectiveService): boolean {
  return perspectives.getActivePerspectiveId()?.startsWith(GEARBOX_PERSPECTIVE_PREFIX) ?? false;
}
