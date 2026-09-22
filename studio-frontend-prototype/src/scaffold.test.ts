/* The skeleton is now a shared contract: the App Spec's gap flow and project
 * creation both write it, into repositories other people's gears already live
 * in. What is worth pinning is therefore the layout (a catalogue that finds
 * `gear.toml` in two places finds neither) and the two things creation varies
 * — the PRD's opening sentence and the manifest's provenance note, which used
 * to be hardcoded to "from an App Spec gap" and would otherwise say so in a
 * gear nobody scaffolded from a spec.
 */
import { describe, expect, it } from "vitest";

import { gearSlug, scaffoldGear } from "./scaffold";

describe("gearSlug", () => {
  it("slugifies what a person types into a name field", () => {
    expect(gearSlug("My Gear")).toBe("my-gear");
    expect(gearSlug("Account Management!")).toBe("account-management");
    expect(gearSlug("  spaced  out  ")).toBe("spaced-out");
  });

  it("never returns an empty directory name", () => {
    // `gears/` + "" would write the files into the store's own root.
    expect(gearSlug("")).toBe("capability");
    expect(gearSlug("!!!")).toBe("capability");
  });
});

describe("scaffoldGear", () => {
  it("writes the canonical five files under gears/<slug>/", () => {
    const s = scaffoldGear("Audit Log", "Studio");
    expect(s.slug).toBe("audit-log");
    expect(s.files.map((f) => f.path)).toEqual([
      "gears/audit-log/gear.toml",
      "gears/audit-log/Cargo.toml",
      "gears/audit-log/src/lib.rs",
      "gears/audit-log/docs/PRD.md",
      "gears/audit-log/docs/DESIGN.md",
    ]);
  });

  it("names the crate and the gear struct from the slug, not the raw input", () => {
    const s = scaffoldGear("Audit Log", "Studio");
    const toml = s.files.find((f) => f.path.endsWith("gear.toml"))!.content;
    const lib = s.files.find((f) => f.path.endsWith("lib.rs"))!.content;
    expect(toml).toContain('name = "cf-gears-audit-log"');
    expect(lib).toContain("pub struct AuditLogGear;");
  });

  it("says the gap story when nobody supplies one", () => {
    const prd = scaffoldGear("search", "Shop").files.find((f) => f.path.endsWith("PRD.md"))!
      .content;
    expect(prd).toContain("no catalogued component provides it");
  });

  it("uses the brief as the PRD's problem, and drops the gap story with it", () => {
    const s = scaffoldGear("search", "Shop", {
      problem: "Sellers cannot find their own listings.",
      origin: "Scaffolded when the project was created.",
    });
    const prd = s.files.find((f) => f.path.endsWith("PRD.md"))!.content;
    const toml = s.files.find((f) => f.path.endsWith("gear.toml"))!.content;
    expect(prd).toContain("Sellers cannot find their own listings.");
    expect(prd).not.toContain("no catalogued component provides it");
    expect(toml).toContain("Scaffolded when the project was created.");
    expect(toml).not.toContain("App Spec gap");
  });

  it("treats a blank brief as no brief", () => {
    // The field is optional, and "   " is what an empty textarea can send.
    const prd = scaffoldGear("search", "Shop", { problem: "   " }).files.find((f) =>
      f.path.endsWith("PRD.md"),
    )!.content;
    expect(prd).toContain("no catalogued component provides it");
  });
});
