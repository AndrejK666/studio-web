// Constructor Studio: what New Gear has to tell a person before they create,
// because the engine will not say it until after.
//
// Two dead ends, both measured against the engine at 55f7015 and reported
// upstream as https://github.com/MikeFalcon77/gearbox/issues/2:
//
//  1. **A scaffolded gear is not in the catalogue.** The engine catalogues a
//     gear by its `#[toolkit::gear(name = "...")]` attribute in `src/lib.rs`,
//     and the scaffold writes that attribute as a comment (it cannot add the
//     toolkit dependency it would need). So the new gear is reported as
//     `GBX0211 no #[toolkit::gear] attribute found`, and a product that names
//     it reports `GBX0301 ... not in the catalogue` -- until the code is written.
//     Studio cannot write the attribute for it: the stub has no toolkit to
//     compile against, and a crate that does not build is worse than an empty
//     one (the engine's own reasoning, `lib_stub`).
//
//  2. **A plugin for a corpus host cannot be scaffolded where it has to live.**
//     A plugin's `gear.gdl` names its host's SDK by a path, and from outside the
//     corpus that path climbs out of the plugin's own source root, which the
//     engine refuses (GBX0102). Inside the corpus is the only place it works,
//     and the scaffold refuses exactly there: "is inside a source root;
//     generation must not write next to human-authored crates".
//
// Pure, so the wording and the path are tested without the widget.

import type { GearKind } from "../../common/generated/GearKind";

export interface GearGuidanceInput {
  readonly kind: GearKind;
  /** The gear will be added to a product when it is created. */
  readonly addingToProduct: boolean;
  readonly gearId: string;
  /** The folder the gear is scaffolded under; the crate is `<destinationDir>/<gearId>`. */
  readonly destinationDir: string;
  /**
   * The host a plugin fills, when one is chosen: its id and the absolute folder
   * of its crate (its `gear.gdl`'s directory), when the catalogue can say.
   */
  readonly host?: { readonly id: string; readonly dir: string | undefined };
}

export interface GearGuidanceNote {
  readonly id: "uncatalogued" | "corpus-plugin";
  readonly text: string;
  /** Where the crate has to end up, for the note that has one. */
  readonly target?: string;
}

export const UPSTREAM_SCAFFOLD_ISSUE = "https://github.com/MikeFalcon77/gearbox/issues/2";

/** The notes New Gear shows beside Create, most important first. */
export function createGearGuidance(input: GearGuidanceInput): GearGuidanceNote[] {
  const notes: GearGuidanceNote[] = [];
  const id = input.gearId.trim() === "" ? "the gear" : input.gearId.trim();
  const crate = `${trimSlash(input.destinationDir)}/${input.gearId.trim() || "<id>"}`;

  if (input.kind === "plugin" && input.host !== undefined) {
    const target =
      input.host.dir === undefined ? undefined : `${trimSlash(input.host.dir)}/plugins/${input.gearId.trim() || "<id>"}`;
    notes.push({
      id: "corpus-plugin",
      text:
        `A plugin for ${input.host.id} has to live in the corpus that declares ${input.host.id}: ` +
        `from anywhere else its gear.gdl reaches the SDK through a path outside its own source ` +
        `root, which the engine refuses (GBX0102). Studio cannot write it there, because the ` +
        `engine refuses to scaffold inside a source root. Create it here, then move ${crate} ` +
        (target === undefined ? `into the corpus beside ${input.host.id}` : `to ${target}`) +
        ` and reload the catalogue.`,
      ...(target === undefined ? {} : { target }),
    });
  }

  notes.push({
    id: "uncatalogued",
    text:
      `${id} enters the catalogue once its src/lib.rs carries #[toolkit::gear(name = "…")], ` +
      `which the scaffold leaves as a comment. Until then the engine reports it as GBX0211` +
      (input.addingToProduct ? `, and the product that names it reports GBX0301` : "") +
      `. Write the attribute (src/lib.rs lists the steps), then reload the catalogue.`,
  });
  return notes;
}

function trimSlash(path: string): string {
  return path.replace(/[\\/]+$/, "");
}
