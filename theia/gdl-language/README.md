# gdl-language

`gear.gdl` and `product.gdl` in the session IDE: highlighting, plus diagnostics,
completion and hover from [Gearbox](https://github.com/MikeFalcon77/gearbox).

The engine is the language server. `gearbox rpc --stdio` answers LSP
`initialize`, `didOpen`/`didChange` with `publishDiagnostics` (the `GBX…` codes of
[gdl.md](https://github.com/MikeFalcon77/gearbox/blob/main/docs/gdl.md)),
`completion` and `hover`. This extension starts it and lets
`vscode-languageclient` carry the protocol; it has no GDL semantics of its own.

- **Where it runs.** The plugin host (node), as an ordinary VS Code extension.
  The session `Dockerfile` builds it in the `gdl` stage and copies the bundle to
  `/app/plugins/gearbox.gdl`; the `gearbox` stage builds the engine at
  a pinned commit (`STUDIO_GEARBOX_REF`) into `/usr/local/bin/gearbox`.
- **Source roots.** The repository around each `gear.gdl` in the workspace
  (nearest `.git`), not the workspace folder: a managed workspace is a container
  of checkouts, and the engine should see each as its own source.
  `gearbox.gdl.roots` overrides it.
- **No engine, no server.** A missing binary leaves highlighting working and
  says why in the `GDL` output channel.

`syntaxes/gdl.tmLanguage.json` is generated from Gearbox's
`ide/gearbox-studio/src/browser/gdl/gdl-grammar.ts` at the same commit, whose
word lists are themselves generated from the engine's globals. Regenerate it
when `STUDIO_GEARBOX_REF` moves.

```sh
npm ci && npm test && npm run build
```
