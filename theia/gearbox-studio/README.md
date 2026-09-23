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
- **Not ported:** everything under Gearbox Studio's `browser/theia/` except
  the read-only `product.lock` editor, its layout migration, the Anthropic key
  settings and `@theia/ai-anthropic`.

## Phases

| | | |
|---|---|---|
| P1 | this package, the engine service, every view reachable from View → Views | done |
| P2 | native GDL language, markers and completion; retire `theia/gdl-language` | |
| P3 | graph, inspector, lock, conflicts, generate verified in a session | |
| P4 | start screen and the create/add wizards verified | |
| P5 | the `@Gearbox` chat agent and tools, through Studio's model | |
| P6 | an opt-in Gearbox perspective, toolbar actions, screen scope, themes | |
