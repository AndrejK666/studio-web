# studio-product-ext

The product surface over Theia: the Markdown editor, quality rail, flow rail and
log, figure and table editors, search, repositories and project views, comments,
tracked changes, and who else is in the document.

## These files are source

**`src/` is hand-written JavaScript. Edit it directly.** There is no TypeScript
behind it, no transpile step, no generator — what you read is what runs.

This directory was called `lib/` until now, and that name cost people real time:
`lib/` is where a Theia extension puts its `tsc` output, so the whole package
read as build artefacts and got skipped. The sibling extensions `studio/` and
`drawio-editor/` *are* TypeScript and *do* keep generated output in their own
`lib/` — which is why the ambiguity was worth removing rather than documenting.

The one exception is called out in its own header:

| file | how to change it |
| --- | --- |
| `src/browser/vendor/markdown-engine.js` | generated — edit `build/markdown-engine.mjs`, then `npm run build:engine` |

That is 206 KB of vendored remark/micromark bundled to CommonJS, out of ~2.3 MB
in the package. Everything else — all 68 files under `src/browser`, plus
`src/node`, `src/common` and `src/flow-mcp` — is written by hand.

## Layout

| directory | runs in | notes |
| --- | --- | --- |
| `src/browser` | frontend bundle | UI, editors, node views, stores |
| `src/node` | Theia backend | preview endpoint, viewer credentials, quality and flow backends |
| `src/common` | both | JSON-RPC service paths shared by the two sides |
| `src/flow-mcp` | its own process | zero-dependency stdio MCP server; see `REGISTER.md` |
| `build/` | build time | the markdown engine generator, and nothing else |
| `test/` | `node` | plain `node:assert` suites, no runner |

Entry points are declared in `package.json` under `theiaExtensions`; Theia's own
generator turns them into `browser-app/src-gen/*`.

## Working on it

```bash
npm test                     # all suites, no runner or browser needed
node test/node-views.test.js # one suite
```

To see a change in a running IDE, rebuild the frontend bundle from `theia/`:

```bash
npm run watch:browser
```

The session container bakes the bundle into the image, so a change reaches a
containerised session only on the next image build.

## This is where the package lives

**The source is here.** `theia/product-ext` is not a copy of anything, and a
change made here is not waiting to be overwritten.

It did not start that way. The package arrived as a vendored copy of
`studio-desktop`'s `app/product-ext` (#167), and this file used to say that a
change made only here was lost on the next sync — which meant every improvement
to the editor carried a deadline nobody was tracking, and most of the
collaboration work landed in 2026-09 sat under it.

That was settled rather than managed: the editor's source lives in this
repository, where it is built, tested and shipped from. Anybody wanting these
files elsewhere copies them *out* of here.

### One thing that did not change, and is easy to get wrong

`src/node/flow-backend.js` still probes for the MCP server under both `src/` and
`lib/`, and that is **not** vendoring left over. `lib/` is the layout of a
PACKAGED application, where the server is copied next to the two modules it
loads because nothing can spawn a script out of an asar archive — see
`src/flow-mcp/REGISTER.md`. Deleting that probe as part of "we do not vendor any
more" would break the desktop build and nothing in this repository's tests would
notice.
