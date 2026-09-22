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

  it("writes the manifest shape every gear in gears-rust actually has", () => {
    // One `[gear]` table and nothing above it. The skeleton used to write bare
    // top-level keys, a `[plugins]` table and a `capabilities` array, and no
    // real manifest is shaped that way -- so the one file a scaffolded gear is
    // judged by was the one file that did not look like its neighbours.
    const toml = scaffoldGear("Audit Log", "Studio").files.find((f) =>
      f.path.endsWith("gear.toml"),
    )!.content;
    expect(toml.startsWith("[gear]\n")).toBe(true);
    // A human name, not the crate: it is what a person reads in the catalogue.
    expect(toml).toContain('name = "Audit Log"');
    expect(toml).toContain("is_plugin = false");
    expect(toml).toContain("has_plugins = false");
    expect(toml).toContain("has_extension_point = false");
    expect(toml).not.toContain("[plugins]");
    expect(toml).not.toContain("capabilities =");
  });

  it("names the crate and the gear struct from the slug, not the raw input", () => {
    // The crate's name lives in Cargo.toml. `gear.toml` carries the human one
    // — that is the split every gear in gears-rust has, and the catalogue reads
    // the manifest for what to show a person.
    const s = scaffoldGear("Audit Log", "Studio");
    const cargo = s.files.find((f) => f.path.endsWith("Cargo.toml"))!.content;
    const lib = s.files.find((f) => f.path.endsWith("lib.rs"))!.content;
    expect(cargo).toContain('name = "cf-gears-audit-log"');
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
