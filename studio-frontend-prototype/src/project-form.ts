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
  /** The repository a product is assembled in. Its own field rather than a
   *  wider `gearRepository`, because the two pages ask different things: a gear
   *  may go into a store somebody else keeps, a product is always new. */
  productRepository: boolean;
  /** The kit picker. */
  components: boolean;
  /** One line saying why there is no kit picker, when there is not. */
  componentsNote: boolean;
}

/** Which sections the card shows. */
export function createFormLayout(kind: ProjectKind, repoMode: RepoMode): CreateFormLayout {
  const gear = kind === "new_gears";
  const sharedStore = gear && repoMode === "existing";
  return {
    gearRepository: gear,
    productRepository: kind === "product",
    components: !sharedStore,
    componentsNote: sharedStore,
  };
}

/** One page of the New project card. */
export type StepKey = "project" | "repository" | "brief" | "components";

export interface CreateStep {
  key: StepKey;
  label: string;
  /** What this page is for, under its title — a wizard that only numbers its
   *  pages makes people click through to find out what each one wants. */
  hint: string;
}

/** The pages this project kind walks, in order.
 *
 *  Not a fixed list: a gear project is asked where the gear goes and the other
 *  two are not, and a gear going into somebody else's store is not offered a
 *  kit (see `createFormLayout`). The page count therefore changes when the type
 *  or the repository road changes, which is why nothing may hold on to a page
 *  INDEX across such a change — `clampStep` exists for exactly that. */
export function createSteps(kind: ProjectKind, repoMode: RepoMode): CreateStep[] {
  const layout = createFormLayout(kind, repoMode);
  const steps: CreateStep[] = [
    { key: "project", label: "Project", hint: "What to call it, and what kind of project it is." },
  ];
  if (layout.gearRepository) {
    steps.push({
      key: "repository",
      label: "Gear repository",
      hint: "Where the gear is written, and what it is called there.",
    });
  }
  if (layout.productRepository) {
    steps.push({
      key: "repository",
      label: "Repository",
      hint: "The repository this product is assembled in. Its own, and new.",
    });
  }
  steps.push({
    key: "brief",
    label: "Brief",
    hint:
      kind === "new_gears"
        ? "What the gear is for. Becomes the problem statement in its PRD."
        : kind === "existing"
          ? "What this app is, and what is being modernized."
          : "What is being built. Becomes the PRD's first answer, which is what the component matching reads.",
  });
  if (layout.components) {
    steps.push({
      key: "components",
      label: "Components",
      hint: "What the project takes from the shared catalogue. All optional.",
    });
  }
  return steps;
}

/** Keep a page index inside a list that just changed length. */
export function clampStep(index: number, steps: readonly CreateStep[]): number {
  if (steps.length === 0) return 0;
  return Math.min(Math.max(index, 0), steps.length - 1);
}

/** Why this page cannot be left yet, as a sentence, or `null`.
 *
 *  Per page rather than per form: a wizard that validates everything on the
 *  last page is a long form with extra clicks. */
export function stepBlocker(
  step: StepKey,
  form: {
    name: string;
    kind: ProjectKind;
    repoMode: RepoMode;
    connectionId: string;
    storePicked: boolean;
    /** A plugin gear with no host picked: its `gear.gdl` names the SDK of the
     *  extension point it fills, so there is nothing to write without one. */
    pluginHostMissing?: boolean;
  },
): string | null {
  if (step === "project") return form.name.trim() ? null : "Name the project.";
  if (step === "repository") {
    if (form.kind === "product") return null;
    const repo = gearRepoBlocker(form.kind, form.repoMode, form.connectionId, form.storePicked);
    if (repo) return repo;
    return form.kind === "new_gears" && form.pluginHostMissing
      ? "Pick the host whose extension point the plugin fills."
      : null;
  }
  return null;
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
