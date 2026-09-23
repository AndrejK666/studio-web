# gearbox-studio

Gearbox inside Constructor Studio: the gear catalogue, products, their
resolution, the lock, conflicts and generation, as Theia views beside
Studio's own.

**Provenance.** Ported from Gearbox Studio,
[`MikeFalcon77/gearbox@7594c25`](https://github.com/MikeFalcon77/gearbox/tree/7594c25ef165916387d1613143d71a0d456415c6/ide/gearbox-studio),
the same commit the session image builds the engine from
(`STUDIO_GEARBOX_REF` in `theia/Dockerfile`). That repository carries no
licence yet. Its owner's permission is needed before this ships beyond
evaluation, and every file copied from it keeps its original text apart from
the changes marked `Constructor Studio:`.

## What is ported, and what is not

Gearbox Studio was a whole IDE. It narrowed Theia by rebinding: it hid the
debug, test, terminal, problems and outline views, quietened the status bar,
pruned menus, owned the workspace, and folded and closed panels as its context
changed (its ADR-0011). None of that is ported. Here Gearbox is one set of
views among Studio's, and Studio's Workbench and Documents perspectives, the
collab strip, Orca and the Explorer stay as they are.

- **Ported as it was:** the protocol and the engine's generated types, the
  engine process and its RPC service, the catalogue and product stores, the
  product edit service, and every view (catalogue, product, inspector, graph,
  conflicts, lock, generate, start, create product and gear, add gear).
- **Adapted:**
  - `node/gearbox-environment.ts` replaces Gearbox Studio's lookup of its own
    Cargo checkout. The workspace is `/workspace` (`GEARBOX_WORKSPACE`), the
    engine is `gearbox` on the PATH (`GEARBOX_ENGINE`), and the roots are the
    checkouts under the workspace that hold a `gear.gdl` (`GEARBOX_ROOT`).
  - Every service that still arranges panels asks
    `shell/gearbox-shell-gate.ts` first, and acts only inside a Gearbox
    perspective.
  - No view opens at start-up. The Product view opens when a person opens a
    product.
- **Opening from the portal.** Each portal section opens the IDE its own way:
  a document from Specs in Documents, a file from Sources in the Workbench, the
  artifact graph from Artifacts, and a product from Components in the Gearbox
  perspective (`studio.openProduct` → `gearbox.product.openAt`), with the
  catalogue left, the product in the middle, the Inspector right and Conflicts
  below. Nothing of Studio's is hidden; switching back restores each layout.
- **Gear projects.** A `new_gears` project is born with a `gear.gdl` the engine
  wrote (the portal's scaffold asks `gearbox/gear/scaffold` for it), and its
  **Open in IDE** sends `studio.openGear` → `gearbox.gear.openAt`: the project's
  gear, found in its checkout (the `gears-rust` corpus beside it is skipped),
  opens in the Gear view of the Gearbox perspective. New Gear defaults its
  destination to the project's repository, beside the gears already there.
- **Not ported:** everything under Gearbox Studio's `browser/theia/` except
  the read-only `product.lock` editor, its layout migration, the Anthropic key
  settings and `@theia/ai-anthropic`.

## Phases

| | | |
|---|---|---|
| P1 | this package, the engine service, every view reachable from View → Views | done |
| P2 | native GDL language, markers, completion and the catalogue checks on any `product.gdl`; `theia/gdl-language` leaves the image (kept as the plain VS Code client) | done |
| P3 | graph, inspector, lock, conflicts, generate verified in a session | |
| P4 | start screen and the create/add wizards verified | |
| P5 | the `@Gearbox` chat agent and tools, through Studio's model | |
| P6a | the Gearbox perspective beside Workbench and Documents; `studio.openProduct` lands a portal product in it; the Inspector links a gear to its page in the portal's component catalogue (`studio.openComponent`) | done |
| P6c | gear projects: `new_gears` scaffolds carry the engine's `gear.gdl`, `studio.openGear` opens the project's gear, New Gear writes into the project's repository | done |
| P6b | toolbar actions on the Product view, screen scope inside the Gearbox perspective, the optional Fabric themes | |
