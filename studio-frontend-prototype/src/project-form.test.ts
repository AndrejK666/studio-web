/* The New project card asked every project the same questions, and for a gear
 * two of them were the wrong questions. These pin the answers, because the only
 * way to see them in the card is to open it and change the radio — which is
 * exactly the check nobody repeats for all six combinations.
 */
import { describe, expect, it } from "vitest";

import { clampStep, createFormLayout, createSteps, gearRepoBlocker, stepBlocker } from "./project-form";

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

describe("createSteps", () => {
  it("asks a gear project where the gear goes, as a page of its own", () => {
    expect(createSteps("new_gears", "new").map((s) => s.key)).toEqual([
      "project",
      "repository",
      "brief",
      "components",
    ]);
  });

  it("does not give a gear going into a shared store a kit page", () => {
    // There is no kit picker for that road, so there is nothing on the page.
    expect(createSteps("new_gears", "existing").map((s) => s.key)).toEqual([
      "project",
      "repository",
      "brief",
    ]);
  });

  it("gives the other kinds three pages and no repository page", () => {
    for (const kind of ["product", "existing"] as const) {
      expect(createSteps(kind, "new").map((s) => s.key), kind).toEqual([
        "project",
        "brief",
        "components",
      ]);
    }
  });

  it("gives every page a hint, because a numbered page says nothing", () => {
    for (const kind of ["new_gears", "product", "existing"] as const) {
      for (const step of createSteps(kind, "new")) {
        expect(step.hint.length, `${kind}/${step.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("tells a gear its brief lands in the PRD, and a product that it does not", () => {
    const hint = (kind: "new_gears" | "product") =>
      createSteps(kind, "new").find((s) => s.key === "brief")!.hint;
    expect(hint("new_gears")).toContain("PRD");
    expect(hint("product")).not.toContain("PRD");
  });
});

describe("clampStep", () => {
  it("keeps a page index inside a list that just got shorter", () => {
    // Switching a gear from a new repository to a shared store drops the kit
    // page while the card is on it.
    const shorter = createSteps("new_gears", "existing");
    expect(clampStep(3, shorter)).toBe(shorter.length - 1);
  });

  it("leaves a valid index alone and floors a negative one", () => {
    const steps = createSteps("new_gears", "new");
    expect(clampStep(2, steps)).toBe(2);
    expect(clampStep(-1, steps)).toBe(0);
  });

  it("answers 0 for an empty list rather than -1", () => {
    expect(clampStep(3, [])).toBe(0);
  });
});

describe("stepBlocker", () => {
  const form = {
    name: "",
    kind: "product" as const,
    repoMode: "new" as const,
    connectionId: "",
    storePicked: false,
  };

  it("will not leave the first page unnamed", () => {
    expect(stepBlocker("project", form)).toBe("Name the project.");
    expect(stepBlocker("project", { ...form, name: "  x  " })).toBeNull();
  });

  it("carries the gear repository's own rule onto its page", () => {
    const gear = { ...form, name: "x", kind: "new_gears" as const, repoMode: "existing" as const };
    expect(stepBlocker("repository", gear)).toBe("Pick the connection that holds the gear store.");
    expect(stepBlocker("repository", { ...gear, connectionId: "c", storePicked: true })).toBeNull();
  });

  it("blocks nothing on the optional pages", () => {
    expect(stepBlocker("brief", form)).toBeNull();
    expect(stepBlocker("components", form)).toBeNull();
  });
});
