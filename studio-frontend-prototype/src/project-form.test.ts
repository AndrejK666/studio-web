/* The New project card asked every project the same questions, and for a gear
 * two of them were the wrong questions. These pin the answers, because the only
 * way to see them in the card is to open it and change the radio — which is
 * exactly the check nobody repeats for all six combinations.
 */
import { describe, expect, it } from "vitest";

import { createFormLayout, gearRepoBlocker } from "./project-form";

describe("createFormLayout", () => {
  it("asks a gear project where the gear goes, and asks nobody else", () => {
    expect(createFormLayout("new_gears", "new").gearRepository).toBe(true);
    expect(createFormLayout("new_gears", "existing").gearRepository).toBe(true);
    expect(createFormLayout("product", "new").gearRepository).toBe(false);
    expect(createFormLayout("existing", "new").gearRepository).toBe(false);
  });

  it("does not offer a kit for a shared gear store, and says why instead", () => {
    // A kit installs with `copy` across every repository the project has, and
    // this one already belongs to the gears in it.
    const shared = createFormLayout("new_gears", "existing");
    expect(shared.components).toBe(false);
    expect(shared.componentsNote).toBe(true);
  });

  it("still offers a kit for a repository created a moment ago", () => {
    const fresh = createFormLayout("new_gears", "new");
    expect(fresh.components).toBe(true);
    expect(fresh.componentsNote).toBe(false);
  });

  it("never shows both the kit picker and the note explaining its absence", () => {
    for (const kind of ["new_gears", "product", "existing"] as const) {
      for (const mode of ["new", "existing"] as const) {
        const l = createFormLayout(kind, mode);
        expect(l.components).not.toBe(l.componentsNote);
      }
    }
  });

  it("drops the journey chips for a gear and keeps them for a product", () => {
    // intent/BRD/PRD/architecture/UI design/user stories/testing is a product's
    // path; a gear has a PRD and a DESIGN, and the skeleton writes both.
    expect(createFormLayout("new_gears", "new").journeyStages).toBe(false);
    expect(createFormLayout("product", "new").journeyStages).toBe(true);
    expect(createFormLayout("existing", "new").journeyStages).toBe(true);
  });

  it("keeps the repository road out of everything but the gear sections", () => {
    // `repoMode` is gear-only state; a product must read the same either way.
    expect(createFormLayout("product", "new")).toEqual(createFormLayout("product", "existing"));
    expect(createFormLayout("existing", "new")).toEqual(createFormLayout("existing", "existing"));
  });
});

describe("gearRepoBlocker", () => {
  it("blocks nothing when a repository is being created", () => {
    // The backend resolves the first GitHub connection itself and names the
    // repository after the project, so neither field is required here.
    expect(gearRepoBlocker("new_gears", "new", "", false)).toBeNull();
  });

  it("blocks nothing for the kinds that touch no repository", () => {
    expect(gearRepoBlocker("product", "existing", "", false)).toBeNull();
    expect(gearRepoBlocker("existing", "existing", "", false)).toBeNull();
  });

  it("names the missing connection before the missing repository", () => {
    expect(gearRepoBlocker("new_gears", "existing", "", false)).toBe(
      "Pick the connection that holds the gear store.",
    );
  });

  it("asks for the repository once the connection is there", () => {
    expect(gearRepoBlocker("new_gears", "existing", "conn-1", false)).toBe(
      "Pick the gear store repository.",
    );
  });

  it("clears once both are picked", () => {
    expect(gearRepoBlocker("new_gears", "existing", "conn-1", true)).toBeNull();
  });
});
