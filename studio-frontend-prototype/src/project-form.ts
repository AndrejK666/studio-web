//! What the New project card asks for, decided apart from the card.
//!
//! The form used to ask every project the same four questions, and two of them
//! were wrong for a gear: a gear has no BRD and no UI Design — that list is a
//! *product's* journey — and a kit copied across "all repositories" is an
//! intrusion when the repository is a gear store somebody else keeps.
//!
//! Which section shows is therefore a decision, not styling, and it lives here
//! for the same reason `tabTarget` lives in modal.ts: the branches are where it
//! goes wrong, and the rest is JSX.

import type { ProjectKind } from "./api";

/** The two roads the `new_gears` radio has always promised in its subtitle. */
export type RepoMode = "new" | "existing";

export interface CreateFormLayout {
  /** Where the gear is written. Only a gear project has one. */
  gearRepository: boolean;
  /** The kit picker. */
  components: boolean;
  /** One line saying why there is no kit picker, when there is not. */
  componentsNote: boolean;
  /** The journey-stage chips. */
  journeyStages: boolean;
}

/** Which sections the card shows.
 *
 *  Hiding the stage chips is not the same as deciding the stage catalogue: the
 *  catalogue moved to the server precisely so an organization owns it (ADR-0014
 *  §7), `intent` stays required, and `normalizeStages` keeps the required
 *  entries whatever the form showed. */
export function createFormLayout(kind: ProjectKind, repoMode: RepoMode): CreateFormLayout {
  const gear = kind === "new_gears";
  const sharedStore = gear && repoMode === "existing";
  return {
    gearRepository: gear,
    components: !sharedStore,
    componentsNote: sharedStore,
    journeyStages: !gear,
  };
}

/** Why the gear project cannot be created yet, as a sentence for the button to
 *  show, or `null` when nothing is missing.
 *
 *  Creating a repository needs neither: the backend resolves "the first GitHub
 *  connection" itself and names the repository after the project. Attaching an
 *  existing gear store needs both, because there is no listing without a
 *  connection to list through and no target without a row picked from it. */
export function gearRepoBlocker(
  kind: ProjectKind,
  repoMode: RepoMode,
  connectionId: string,
  storePicked: boolean,
): string | null {
  if (kind !== "new_gears" || repoMode === "new") return null;
  if (!connectionId) return "Pick the connection that holds the gear store.";
  if (!storePicked) return "Pick the gear store repository.";
  return null;
}
