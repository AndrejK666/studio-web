//! The starter-gear skeleton, shared by the two places that ask for one.
//!
//! It was a private function in documents.tsx, where the only caller was the
//! App Spec's capability-gap flow. Project creation now scaffolds a gear too —
//! that is the whole point of a `new_gears` project — and a second copy of the
//! canonical layout is exactly the kind of drift that makes two gears in the
//! same catalogue disagree about where `gear.toml` lives.
//!
//! The two callers differ only in *why* the gear is being made, so that is what
//! they pass: a gap flow says "no catalogued component provides it", creation
//! says what the brief says.

export type ScaffoldFile = { path: string; content: string };
export type Scaffold = { capability: string; slug: string; files: ScaffoldFile[] };

/** `My Gear` / `my gear` / `My-Gear` → `my-gear`. Also what the skeleton's own
 *  directory is named, so a form can show the real path before writing it. */
export function gearSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "capability";
}

function pascal(s: string): string {
  return s.replace(/(^|[-_ ])(\w)/g, (_m, _sep, c: string) => c.toUpperCase());
}

/** A canonical toolkit-gear skeleton for a missing capability: manifest, crate,
 *  the `#[toolkit::gear]` entrypoint, and PRD/DESIGN stubs (so it reads well in
 *  the catalog immediately). This is the harness an agent then fills in.
 *
 *  `problem` replaces the PRD's opening sentence and `origin` the manifest's
 *  provenance note — a gear scaffolded from a project brief was not found by
 *  reading an App Spec, and saying so in its own PRD would be a lie the next
 *  reader has to unpick. */
export function scaffoldGear(
  capability: string,
  appTitle: string,
  opts?: { problem?: string; origin?: string },
): Scaffold {
  const slug = gearSlug(capability);
  const crate = `cf-gears-${slug}`;
  const Gear = `${pascal(slug)}Gear`;
  const origin = opts?.origin ?? "Scaffolded from an App Spec gap.";
  const problem =
    opts?.problem?.trim() ||
    `${appTitle} needs the \`${capability}\` capability, and no catalogued component provides it.`;
  const gearToml =
    `name = "${crate}"\n` +
    `description = "${capability} capability for ${appTitle}. ${origin}"\n` +
    `category = "platform"\n` +
    `capabilities = ["${capability}"]\n\n` +
    `[plugins]\ndeclared = false\n`;
  const cargoToml =
    `[package]\nname = "${crate}"\nversion = "0.1.0"\nedition = "2021"\n\n` +
    `[dependencies]\ntoolkit = { workspace = true }\nasync-trait = { workspace = true }\nanyhow = { workspace = true }\n`;
  const lib =
    `//! ${crate} — the \`${capability}\` capability. ${origin}\n` +
    `//! Fill in the service, GTS types and REST surface.\n\n` +
    `use async_trait::async_trait;\nuse toolkit::{Gear, GearCtx};\n\n` +
    `#[toolkit::gear(\n    name = "${crate}",\n    deps = [],\n    capabilities = [rest]\n)]\n` +
    `#[derive(Default)]\npub struct ${Gear};\n\n` +
    `#[async_trait]\nimpl Gear for ${Gear} {\n` +
    `    async fn init(&self, _ctx: &GearCtx) -> anyhow::Result<()> {\n` +
    `        // TODO: register GTS types, resolve dependencies, wire the ${capability} service.\n` +
    `        Ok(())\n    }\n}\n`;
  const prd =
    `---\nstatus: draft\nowner: \n---\n\n# PRD — ${capability} gear\n\n` +
    `## Problem\n\n${problem}\n\n` +
    `## Goals\n\n- Provide \`${capability}\` as a reusable gear other apps can compose.\n\n` +
    `## Non-Goals\n\n## Users & Use Cases\n\n## Requirements\n\n## Success Metrics\n`;
  const design =
    `---\nstatus: draft\n---\n\n# Design — ${capability} gear\n\n## Overview\n\n` +
    `## Architecture\n\n\`\`\`mermaid\ngraph LR\n    Client --> G["${capability}"]\n    G --> DB[(storage)]\n\`\`\`\n\n` +
    `## Data Model\n\n## Interfaces\n\n## Trade-offs\n`;
  return {
    capability,
    slug,
    files: [
      { path: `gears/${slug}/gear.toml`, content: gearToml },
      { path: `gears/${slug}/Cargo.toml`, content: cargoToml },
      { path: `gears/${slug}/src/lib.rs`, content: lib },
      { path: `gears/${slug}/docs/PRD.md`, content: prd },
      { path: `gears/${slug}/docs/DESIGN.md`, content: design },
    ],
  };
}
