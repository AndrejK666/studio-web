---
type: adr
status: proposed
date: 2026-11-27
---

# ADR-0080: The IDE is a kit behind a core port, so a deployment runs Theia or VS Code

**ID**: `cpt-studio-adr-ide-runtime-port`

Status: **proposed** · Date: 2026-11-27 · Builds on `cpt-studio-adr-core-knows-no-kit` (ADR-0079: the core's ports), `cpt-studio-adr-theia-sessions` (ADR-0003), `cpt-studio-adr-theia-backend-bridge` (ADR-0022), `cpt-studio-adr-a-desktop-session-keeps-the-secrets-on-the-server` (ADR-0027), `cpt-studio-adr-a-shared-session-is-many-people-each-as-themselves` (ADR-0030), `cpt-studio-adr-the-desktop-gets-its-tools-as-extensions` (ADR-0032)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Drivers](#decision-drivers)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. The core keeps the session; a kit brings the IDE](#1-the-core-keeps-the-session-a-kit-brings-the-ide)
  - [2. The port: IDE runtime](#2-the-port-ide-runtime)
  - [3. Two kits: ide-theia and ide-vscode](#3-two-kits-ide-theia-and-ide-vscode)
  - [4. One bridge protocol for both IDEs](#4-one-bridge-protocol-for-both-ides)
  - [5. Our features become VS Code extensions where they can](#5-our-features-become-vs-code-extensions-where-they-can)
  - [6. Which IDE runs is a setting](#6-which-ide-runs-is-a-setting)
- [Phases](#phases)
- [Consequences](#consequences)
- [Confirmation](#confirmation)
- [More Information](#more-information)
  - [Survey: our in-IDE features](#survey-our-in-ide-features)
  - [Survey: the backend](#survey-the-backend)
  - [Survey: the portal](#survey-the-portal)
  - [Risks and open questions](#risks-and-open-questions)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

A project's IDE in Studio is Theia. ADR-0003 runs one Theia container per
workspace, ADR-0022 lets the backend call it, ADR-0027 makes the desktop app
an Electron Theia, and ADR-0030 shares one container among many people
through a Theia seam. All our in-IDE features are Theia extensions.

Some teams want VS Code in the browser (openvscode-server or code-server)
instead. They know it, their extensions run in it, and it is the editor of
most other cloud workspaces. Studio is a shell plus a core extended by kits
(ADR-0068, ADR-0079), so the IDE should be a kit too: a deployment picks
Theia or VS Code, later an organization or a project does.

Today the IDE is not cleanly a kit. ADR-0079 already made one port,
`crate::ide_bridge::IdeBridge` (status, notify, repositories, install a kit),
filled by `studio_theia`. But the session gear launches a Theia image, dials
Theia's control path itself, and names Theia's token. The portal shell speaks
Theia's `postMessage` names. And none of our IDE features would run in VS Code.

## Decision Drivers

- The core names no IDE (ADR-0079 §3).
- Today's behaviour, the desktop included, does not change until a
  deployment turns VS Code on.
- One protocol between Studio and any IDE; no second dialect to keep.
- Feature code written once where the two IDEs allow it.
- What the user sees in a running session is not broken by a switch.

## Considered Options

1. **An IDE runtime port in the core; Theia and VS Code as two kits that fill
   it; one bridge protocol; features move to VS Code extensions where they
   can, so the same code runs in both.**
2. **Keep Theia, add VS Code as a second hard-coded branch in studio-session
   and the portal.** Fast for the first launch, but every later change touches
   both branches in the core, against ADR-0079.
3. **Replace Theia with VS Code everywhere.** One IDE again, but it loses the
   desktop app, the shared session's per-person identity and every Theia
   extension at once: about 150k lines of TypeScript and JavaScript
   (survey below).

## Decision Outcome

Chosen: **1**.

### 1. The core keeps the session; a kit brings the IDE

The **core** (`studio_session` and the container plumbing) keeps everything
that is the same whatever the IDE is:

- the session lifecycle: launch, reuse, adopt, ready, idle reaping, stop;
- the drivers (Docker, Kubernetes) and the volume;
- the reverse proxy and the session gate (the cookie, `STUDIO_SESSION_TOKEN`,
  the `/__studio_session_ready__` answer, the same-origin `/studio-api`
  forwarding);
- sign-in and the per-person identity rules of ADR-0030 §1, §3, §4;
- the checkout: `STUDIO_SOURCES`, `materialize-workspace.mjs`,
  `.cf-workspace.toml`, `git-credentials.mjs`;
- the git broker (`studio-git`) and the LLM broker (`studio-llm-proxy`), and
  the env that points at them (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
  `STUDIO_LLM_AUTH`);
- metering;
- the desktop leases (`desktop.rs`) and the command channel to a desktop
  (today `studio_theia/commands.rs`, an IDE-neutral contract on
  studio-events);
- the bridge protocol's contract (§4) and its REST face for the portal and
  MCP.

An **IDE kit** brings the IDE: its image, how it starts and answers, how the
backend reaches it, what it can do, and the IDE-side half of the bridge.

### 2. The port: IDE runtime

`crate::ide_runtime::IdeRuntime`, registered by an IDE kit's gear
(`inventory`, ADR-0079 §4). `IdeBridge` stays as its control half. A runtime
supplies:

| Part | What it is | Theia today |
|---|---|---|
| `id` | `theia`, `vscode` | — |
| **Image** | the image and its pull policy | `cf-studio-theia`, `studio-session.image` |
| **Launch spec** | the port the gate holds, extra env, extra args, the container name, resources | 3003, `THEIA_WEBVIEW_EXTERNAL_ENDPOINT`, container `theia` |
| **Readiness** | how the gate knows the IDE behind it answers | the gate's upstream connect |
| **Control endpoint** | the path prefix the gate passes through, the token's env and header | `/internal/theia/v1`, `STUDIO_THEIA_S2S_TOKEN`, `X-CFS-Theia-Token` |
| **Bridge** | the `IdeBridge` calls, over that endpoint | `TheiaIdeBridge` |
| **Capabilities** | flags the core and the portal read before they ask | all on |
| **Desktop** | whether the kit has a desktop app, and its link scheme | Electron Theia, `desktop-link.ts` |

The capabilities are: `open_file`, `open_document`, `notify`,
`repositories`, `operations` (the git operation queue and its journal),
`install_kit`, `shared_session` (many people, each as themselves, ADR-0030),
`idle_report`, `desktop`. A call the runtime has not flagged answers
"this IDE cannot …" as a sentence, never a 404.

The core keeps the port's single implementation per session: it records the
runtime's `id` on the session (a container label `cf.studio/ide` and a
field in the session row) and uses that runtime for the session's life.

Three Theia references in the core go behind the port:

- `service.rs` dials `/internal/theia/v1/getRuntimeStatus` with
  `X-CFS-Theia-Token` for idle reaping; it asks the port instead.
- `config.rs`'s `image` and `theia_control_enabled` move to the kit's
  config (`gears.ide-theia.image`); the old keys are read for one release.
- `sdk.rs`'s `TheiaControlEndpoint` becomes `IdeControlEndpoint`.

### 3. Two kits: ide-theia and ide-vscode

The `ide` kit stays the one the member sees: the IDE tab (`space-mfe`, an
iframe of the session's address) and the desktop hand-off. It needs one
runtime kit switched on. The two runtime kits:

**`ide-theia`** is today, unchanged:

- the image built from `theia/` (`browser-app`, with `studio`,
  `studio-product-ext`, `gearbox-studio`, `drawio-editor`);
- the gear `studio-theia` (control client, discovery, event sink,
  `TheiaIdeBridge`), as ADR-0079 §7 already placed it;
- the Theia side of the bridge (`studio-control-api.ts`,
  `portal-bridge-contribution.ts`, `studio-event-forwarder.ts`);
- the shared-session seam (`viewer-credentials.js`, `agent-credentials.ts`);
- the desktop app (`theia/electron-app`, `studio-kits-view`, ADR-0027 and
  ADR-0032).

**`ide-vscode`** is new:

- an image on openvscode-server (MIT, the upstream VS Code server with
  open-vsx as its marketplace), with the same entrypoint, gate, checkout and
  git helper as the Theia image: those scripts move to a shared
  `docker/session-base` layer both images copy;
- a VS Code extension, `constructorfabric.studio-bridge`, that serves the
  control endpoint on a loopback port the gate passes through, forwards
  events, and is the frame side of the portal channel (§4);
- the built-in `vscode.git` (it is the same extension Theia runs), the
  terminal, and Claude Code and Codex as their open-vsx extensions and CLIs,
  pointed at the LLM broker by the same env;
- no gear of its own at first: its `IdeBridge` is the same control client
  as Theia's, on the neutral path (§4), so the client moves to the core's
  bridge contract and `studio-theia` keeps only what is Theia's.

code-server is the fallback if openvscode-server's release cadence or its
server-side hooks fall short; the port does not care which.

### 4. One bridge protocol for both IDEs

There are three channels today, all spelled for Theia. Each becomes one
protocol, defined once in a package both IDE sides and the portal import
(`@constructor-studio/ide-bridge`, TypeScript types and message names, with
the Rust structs generated from or tested against it), versioned `v2`.

**Control: backend to IDE.** The calls stay the ones of
`docs/theia-bridge-contract-v1.md`: `getRuntimeStatus`, `getSession`,
`getRepositories`, `enqueueOperation`, `getOperationDeltas`,
`retryOperation`, `openInEditor`, `notifyEditor`, `installKit`, plus
`openDocument` (today only a `postMessage`). The path becomes
`/internal/ide/v2/*`, the header `X-CFS-Ide-Token`, the env
`STUDIO_IDE_CONTROL_TOKEN`. `getRuntimeStatus` answers the runtime's
capabilities. The gate passes the path through to whichever local process
serves it: the Theia node, or the VS Code extension's loopback listener.
For one release the gate and the Theia node also answer the v1 path and
token, and adoption reads either env, so sessions started before the switch
keep their bridge.

**Events: IDE to backend.** The ingress stays; the envelope's kind becomes
`ide.<kind>` with the runtime's `id` beside it, instead of `theia.<kind>`.
The `studio-events` subscribers read both for one release.

**The frame: portal to IDE and back.** The portal shell names none of the
messages any more. Today `app/mfe/editorBridge.ts` is the shell's and the
shell ratchet (`app/shellNamesNoKit.test.ts`) pins four leaks in
`UNSEEN_LEAKS`: `'studio.openDocument'`, `'studio.openComponent'`, and
`editor_component_unavailable` in `en.json` and `ru.json` (the last waits on
#583). They go as follows:

- **The bridge moves into the `ide` kit** (`kits/ide/`), behind a shell port
  `editor`. The shell asks the port to open an artifact as `{ kind, ref }`;
  it never builds a message.
- **The shell finds the editor screen by declaration.** That mechanism
  exists: `space-mfe/mfe.json`'s `presentation.opens` says which artifact
  kinds the screen opens and how its frame is told about each (`file` →
  `path`, `document` → `workspace`), and the shell reads it instead of the
  `space` token (commit `9210645b3`, branch `shell-no-kit-leaks`). The
  kit's bridge turns `{ kind, ref }` into the protocol's message.
- **The IDE's requests are artifacts too.** `studio.openComponent { name }`
  becomes `ide.openArtifact { kind: "component", ref }`. The shell routes it
  to the screen whose `presentation.opens` names that kind (the components
  kit's screen declares `component`), as it routes any artifact-open.
- **No kit-named sentence in the shell.** When no installed screen opens a
  kind, the shell says so in its own generic words
  (`shell:artifact_open_unavailable`, "Nothing in this Studio opens a
  {{kind}}"), and `editor_component_unavailable` goes. This also settles
  what #583 was waiting for.
- **Names.** `studio.init`, `studio.theme`, `studio.token`,
  `studio.openInEditor`, `studio.openDocument`, `studio.openComponent`,
  `studio.documentSaved`, `studio.status`, `studio.notify`, `studio.openGraph`,
  `studio.openProduct`, `studio.openGear` become `ide.*` in v2. `ide.init`
  carries `protocol: 2`.

With that the four `UNSEEN_LEAKS` entries go, and the list is empty.

**Both IDE sides change together.** The protocol package is the only
source of the names. The Theia side (`portal-bridge-contribution.ts`) and
the VS Code side (`studio-bridge`) each have a contract test against it, and
the portal's `ide` kit has one too. The switch is one release: the Theia
side answers `studio.*` and `ide.*` for that release, the portal sends v2
once the frame answers v2 and v1 otherwise, so an old image under a new
portal and a new image under an old portal both work. The v1 names then go
from the Theia side and the package.

**How VS Code hears the frame.** A VS Code extension runs in the extension
host, a Node process, and cannot see the workbench window's `message`
events. So the gate, which already serves every page of the session,
injects one small script into the workbench page it passes through (the
`ide-vscode` runtime declares the page and the script). The script takes
the portal's `postMessage`, checks the origin as the Theia side does, and
relays it over a WebSocket on the gate (`/__ide/bridge`) to `studio-bridge`,
and back. Theia keeps answering in its own frontend.

### 5. Our features become VS Code extensions where they can

Theia runs VS Code extensions (`@theia/plugin-ext-vscode`; our images
already run `vscode.git` and `vscode.markdown` at 1.95.3). A feature written
as a VS Code extension runs in both IDEs, so where the VS Code API is enough
the port **replaces** the Theia version, and `ide-theia` ships the same
`.vsix`. That is realistic for most of the document and panel features
(webviews, custom editors, tree views, commands). It is not realistic for
the parts that are Theia's by nature, which stay in `ide-theia` and have no
VS Code counterpart:

- the shell layout, modes, perspectives, chrome and theme
  (`studio-mode-*`, `studio-chrome-mode.ts`, `studio-perspectives.ts`);
- the shared session's per-connection identity (ADR-0030 §2: Theia's
  `ConnectionContainerModule` and `PluginHostEnvironmentVariable`; VS Code
  has no hook that shapes one extension host's environment per connection);
- the Theia AI agents (`gearbox-studio/src/browser/ai`, `@theia/ai-chat`,
  `@theia/ai-claude-code`, `@theia/ai-codex`);
- the desktop app's Electron parts and the kits in the Extensions view
  (ADR-0032 §4).

The survey's table gives each feature its kind and cost.

### 6. Which IDE runs is a setting

- **A deployment first.** The composition switch of ADR-0079 §5 turns kits'
  gears on. `ide` needs exactly one of `ide-theia` and `ide-vscode` for the
  browser; with both on, the deployment names its default
  (`studio-session.ide = "theia"`), with neither the IDE tab says the
  deployment has no IDE. Switching needs a restart, not a rebuild.
- **An organization or a project later.** The port is keyed by `id` and
  several runtimes may be on. A launch picks the project's setting, else the
  organization's, else the deployment's default. A session is per
  workspace, so the project is the finest grain.
- **Running sessions.** A session keeps the runtime it started with until it
  stops (the label of §2). On adoption after a restart, a session whose
  runtime is still on is adopted as today. One whose runtime is now off, or
  is no longer the project's choice, is shown as needing a restart, and the
  next open stops it and starts the chosen IDE on the same volume: the
  files, worktrees and uncommitted changes stay; the IDE's own state (layout,
  open editors, IDE settings) does not carry over.
- **The desktop.** The desktop app is `ide-theia`'s and talks to the
  backend, not to the browser IDE (leases, git and LLM brokers, commands on
  studio-events). A deployment can run `ide-vscode` in the browser and keep
  the desktop on, since `ide-theia`'s desktop part has its own switch. A VS
  Code desktop (the member's own VS Code with our extensions and Studio
  sign-in) is a later choice, not part of this ADR.

## Phases

Estimates are one engineer, from the survey; ranges cover the stand and
review rounds.

**P1. Theia behind the port, no behaviour change.** 3–4 weeks.

- Backend: `crate::ide_runtime` with the `IdeRuntime` registration; the
  session gear reads image, port, env, readiness, control endpoint and idle
  probe from it; `studio_theia` registers the Theia runtime; the runtime id
  on the session; config keys with one-release aliases. The allowlist pairs
  `api_contract -> studio_theia` and `notify -> studio_theia` go.
- Protocol v2: the package; the `/internal/ide/v2` path, header and token
  beside v1; `ide.*` events beside `theia.*`; `/studio-ide/v1` REST beside
  `/studio-theia/v1`.
- Portal: the bridge into `kits/ide`, `ide.openArtifact` routed by
  `presentation.opens`, the generic sentence; `UNSEEN_LEAKS` empty.
- Image: the shared `session-base` layer.
- The kit manifests: `ide` gains `requires` one runtime; `ide-theia.kit.json`.

**P2. ide-vscode, minimal.** 5–7 weeks.

- The openvscode-server image on `session-base` (1 week).
- `studio-bridge`: control endpoint with `getRuntimeStatus`, `getSession`,
  `getRepositories`, `openInEditor`, `openDocument`, `notifyEditor`; events;
  the frame relay and the gate's injection; theme and viewer (2–3 weeks).
  `operations` and `install_kit` are flagged off.
- Git through the broker: `git-credentials.mjs` and `vscode.git` as they are
  (days).
- LLM: Claude Code and Codex through the broker (1 week, see the open
  question on the token).
- The file hand-off: portal to IDE (`open_file`, `open_document`) and IDE to
  portal (`ide.openArtifact`) (in the bridge work above).
- One person per session: `shared_session` is off, so the launch keys
  the session by (workspace, person) as ADR-0003 did (days).
- The stand and a CDP check of the real IDE (1 week).

**P3. Port the features, by value over cost.** Each a VS Code extension that
`ide-theia` ships too, replacing its Theia version.

| # | Feature | Weeks |
|---|---|---|
| 1 | Rendered markdown diff | 1–2 |
| 2 | Quality rail and spec findings | 3–4 |
| 3 | Share (the share-PR flow) | 1–2 |
| 4 | Doc editing › Domain model | 1–2 |
| 5 | The git operation queue, journal and Workspace Sources (`operations`, `install_kit`) | 3–5 |
| 6 | The Markdown WYSIWYG editor with figures, tables, comments, tracked changes | 6–9 |
| 7 | Collaboration in that editor (who else is in the document) | 2–3 |
| 8 | Agents panel (Orca) | 2 |
| 9 | Draw.io: replace with an open-vsx extension | 0.5 |
| 10 | Workspace and artifact graphs, Analyze, Components reference | 4–6 |
| 11 | Gearbox Studio (the gear catalogue, product, generate; its AI agents stay Theia) | 8–12 |

Items 1–5 (about 3 months) bring VS Code to the features the portal sends
people into the IDE for. Items 6–11 are another 6–8 months, and 11 may stay
Theia only.

## Consequences

- Good: a deployment can offer VS Code in the browser; later an
  organization or a project chooses.
- Good: the core names no IDE; the session, gate, checkout and brokers are
  shared by both kits.
- Good: the bridge has one protocol and one source of names, and the shell
  ratchet's `UNSEEN_LEAKS` is empty.
- Good: a feature ported in P3 is written once and runs in both IDEs.
- Bad: two images to build, scan and pin. The shared base keeps the
  difference to the IDE layer.
- Bad: VS Code gives up the shared session (one person per container), the
  Theia shell modes and the Theia AI agents, at least until P3 and maybe
  for good.
- Bad: VS Code hears the portal through a script the gate injects into its
  page, which depends on openvscode-server's page shape; a pinned image and a
  test against it hold that.
- Bad: one release of two protocol versions side by side.

## Confirmation

- `core_kit_tests.rs`: no core module names `studio_theia`; the two pairs
  leave `core_kit_allowlist.txt`.
- A test in `studio_session` launches with a fake runtime and finds no
  `3003`, `theia` or `X-CFS-Theia-Token` in the launch spec that the
  runtime did not give.
- `shellNamesNoKit.test.ts`: `UNSEEN_LEAKS` is empty.
- The protocol package's contract tests pass on the portal's `ide` kit, the
  Theia side and `studio-bridge`.
- P1: the Theia session, the desktop and every IDE feature behave as before
  on the stand.
- P2: on the stand with `ide-vscode` on, a project opens in VS Code, a file
  and a document open from the portal, a commit pushes through the broker,
  Claude Code answers through the LLM broker, a component link in the IDE
  opens the component's page.

## More Information

### Survey: our in-IDE features

Counted on 2026-11-27 at `8d4bbf80d`, non-test sources. `theia/studio` and
`theia/drawio-editor` are TypeScript; `theia/product-ext/src` is hand-written
JavaScript. All four are **Theia extensions** (`theiaExtensions` in their
`package.json`, InversifyJS, `@theia/*`): `studio` imports `@theia/*` in 122
files, `product-ext` in 35, `gearbox-studio` in 83 (`@theia/ai-*` in 10).
The only **VS Code extensions** of ours are `gdl-language` (258 lines, a
grammar), `studio-cli` (wraps `cfs`) and `gearbox-engine` (wraps the
engine binary); they run in VS Code as they are.

| Feature | Where | Kind | Size (lines) | Port to the VS Code API |
|---|---|---|---|---|
| Quality rail, spec findings | `product-ext/src/browser/quality-*`, `node/quality-backend.js`, `node/quality-runner.js` | Theia ext | ~9.7k | webview view plus a command; the runner is plain Node and moves as is. 3–4 w |
| Markdown WYSIWYG editor (figures, tables, mermaid, math, comments, tracked changes, suggest marks) | `product-ext/src/browser/markdown-editor.js`, `md-*`, `figure-*`, `table-*`, … ; `studio/src/browser/markdown-editor/` | Theia ext | ~22k | `CustomTextEditorProvider` over a webview; the editor is DOM code and moves, the Theia widget, saveable and RPC glue are rewritten. 6–9 w |
| Collaboration (who is in the document) | `product-ext/src/browser/collab-*`, `node/collab*.js` | Theia ext | ~2k | Theia JSON-RPC to the extension host's own channel; per-person identity depends on §5's limits. 2–3 w |
| Rendered markdown diff | `studio/src/browser/markdown-diff/` | Theia ext | ~1.9k | webview panel opened from SCM; renderer moves. 1–2 w |
| Doc editing › Domain model | `studio/src/browser/desktop-domain-model-*`, `common/desktop-domain-model.ts` | Theia ext (desktop only today) | ~1.4k | webview view. 1–2 w |
| Share, share-PR flow | `studio/src/browser/share/`, `node/document-share-service.ts` | Theia ext | ~1.7k | command plus quick picks; the service is Node. 1–2 w |
| Portal bridge (frame `postMessage`) | `studio/src/browser/portal-bridge-contribution.ts` | Theia ext | ~0.6k | `studio-bridge` plus the gate's relay (§4). In P2 |
| Control API (ADR-0022) | `studio/src/node/studio-control-api.ts`, `studio-backend-module.ts` | Theia ext (node) | ~1.1k | loopback HTTP server in the extension host. In P2 |
| Events to studio-events | `studio/src/node/studio-event-forwarder.ts`, `studio-event*` | Theia ext (node) | ~0.2k | same code in the extension host. In P2 |
| Git operations, Workspace Sources, operation journal, repository registry, kit installer | `studio/src/node/workspace-*`, `git-*`, `repository-*`, `operation-*`, `kit-installer.ts`; browser widgets | Theia ext | ~14k | the Node services move (they bind through Inversify; the logic is plain Node); widgets become tree views and webviews. 3–5 w |
| Git and LLM broker clients | `docker/git-credentials.mjs`; `studio/src/node/desktop-git.ts`, `desktop-llm-proxy.ts`, `git-executor.ts` | container script (neutral); desktop parts Theia ext | ~1.1k | container half is shared already; desktop half stays Theia |
| Theia AI settings, per-member agent key | `studio/src/browser/agent-credentials.ts` (`@theia/ai-claude-code`, `@theia/ai-codex`) | Theia ext | ~0.2k | no equivalent: VS Code's Claude Code and Codex read env and their own login. Open question 2 |
| Shared-session identity (HOME per viewer) | `product-ext/src/node/viewer-credentials*.js`, `assistant-auth.js` | Theia ext (Theia seam) | ~0.8k | not portable (§5); VS Code runs one person per session |
| Agents panel (Orca) | `studio/src/browser/orca-*`, `node/orca-*` | Theia ext | ~3.3k | webview view; terminal streaming over the extension host. 2 w |
| Workspace graph, artifact graph, Analyze, Audit, Components reference, roadmap | `studio/src/browser/*-graph-*`, `analyze-*`, `components-reference-*`, `roadmap-*` | Theia ext | ~7.7k | webviews. 4–6 w |
| Shell modes, layout, chrome, theme, start pages | `studio/src/browser/studio-mode-*`, `studio-chrome-mode.ts`, `studio-perspectives.ts`, `theme/`, `studio-start-pages*` | Theia ext | ~2.8k | not portable; VS Code keeps its own workbench. A walkthrough and a theme extension cover part |
| Desktop app (sign-in, landing, leases, updates, Extensions view kits) | `studio/src/browser/desktop-*`, `node/desktop-*`, `electron-*`; `electron-app/`; `studio-kits-view/` | Theia ext + Electron | ~7k | stays `ide-theia` |
| Gearbox Studio (catalogue, product, generate, create, AI agents) | `gearbox-studio/src` | Theia ext | ~40k (AI ~2.5k) | webviews and custom editors for most; the Theia AI chat agents stay Theia. 8–12 w |
| Draw.io editor | `drawio-editor/src` | Theia ext | ~3.7k | replace with an open-vsx Draw.io extension. 0.5 w |
| GDL language | `gdl-language/` | VS Code ext | 0.3k | none |
| `cfs` CLI, gearbox engine | `studio-cli/`, `gearbox-engine/` | VS Code ext | small | none |

The session image runs `studio`, `studio-product-ext`, `gearbox-studio` and
`drawio-editor` (`theia/browser-app/package.json`); the desktop adds
`studio-kits-view` (`theia/electron-app/package.json`).

### Survey: the backend

**`studio_session`** (7.4k lines) is mostly IDE-neutral. Theia-bound:

- `config.rs`: `image` (default `cf-studio-theia:edge`),
  `theia_control_enabled`, allowed origins (which Theia validates at start).
- `driver.rs`, `docker.rs` (`THEIA_PORT = "3003/tcp"`), `k8s.rs`
  (`THEIA_PORT = 3003`, container name `theia`, `CONTROL_TOKEN_ENV =
  "STUDIO_THEIA_S2S_TOKEN"`). The ready path `/__studio_session_ready__` is
  the gate's and neutral.
- `service.rs`: mints `STUDIO_THEIA_S2S_TOKEN`; dials
  `/internal/theia/v1/getRuntimeStatus` with `X-CFS-Theia-Token` for idle
  reaping (line 135); resolves the control endpoint and token
  (`resolve_control_token`). Neutral: `ANTHROPIC_BASE_URL`,
  `OPENAI_BASE_URL`, `STUDIO_LLM_AUTH`, the sources and
  `.cf-workspace.toml` (written by `materialize-workspace.mjs`), Orca beside
  the IDE.
- `sdk.rs`: `TheiaControlEndpoint` and the discovery client.
- `proxy.rs`, `rest.rs`, `access.rs`, `metering.rs`, `reap_task.rs`,
  `ready_task.rs`, `launch_sources.rs`, `desktop.rs`, `desktop_rest.rs`:
  neutral (comments name Theia).

The "broker env set after the plugin host" and the HOME per person live in
the image, not the backend: `viewer-credentials*.js` shape each Theia plugin
host's env through `PluginHostEnvironmentVariable` (ADR-0030 §2), and the
desktop sets the broker env in `desktop-studio-contribution.ts` (the #710
fix). Both are Theia's.

The **container** (`theia/docker/entrypoint.sh`, 624 lines): the splash, the
gate, the checkout and the git helper are neutral. Theia-bound: the
`THEIA_WEBVIEW_EXTERNAL_ENDPOINT` check, the gate's pass-through of
`/internal/theia/v1/*` and of Theia's `/webview/*` shell, and the final
`node … browser-app` start.

**`studio_theia`** (2.0k lines, feature `theia-bridge`):

- `control_client.rs`, `discovery.rs`: HTTP to `/internal/theia/v1/*` with
  the token; neutral once the path and header are the protocol's.
- `ide_bridge.rs`: `TheiaIdeBridge`, the `IdeBridge` of ADR-0079.
- `sink.rs`: forwarded events as `theia.<kind>` on studio-events (or the
  event broker under `theia-event-broker`).
- `commands.rs`: desktop commands (`open_in_editor`, `enqueue_operation`,
  `retry_operation`) published as `desktop_session.command_sent`; neutral.
- `rest.rs`: `/studio-theia/v1/workspaces/{id}/{status,session,repositories,operations,open}`,
  the event ingress, the desktop-session command routes.

Its callers: `notify` (`IdeBridge::notify`, and its error text names the
gear), `kit_registry` (`IdeBridge::install_kit`), `api_contract` (the REST
domains), the portal's `kits/ide/shell.ts`
(`/cf/studio-theia/v1/desktop-sessions/{id}/commands`), the Theia node
(`desktop-bridge.ts`, `studio-event-forwarder.ts`) and `studio-frontend-poc`.
No MCP tool calls it. `organizations/status.rs` names the `ide` kit for a
next step ("open the IDE"), pinned as `organizations -> kit:ide`; that stays,
since `ide` stays the member's kit.

### Survey: the portal

- `space-mfe` (`mfe.json`) is an iframe entry whose URL is the
  `space.mfe.frame_url` property the shell publishes from the session's
  `url`. It is IDE-neutral.
- `app/mfe/editorBridge.ts` (130 lines) and `app/effects/editorSessionEffects.ts`
  (574 lines) are the shell's half of the frame channel and speak the
  `studio.*` names; `app/mfe/MfeHandlerIframe.ts` leaves the frame
  unsandboxed (#323). §4 moves the channel into `kits/ide`.
- `kits/ide/shell.ts` fills `desktop.openFile`, posting a desktop command
  to `/cf/studio-theia/v1/...`; it moves to the neutral REST path.
- `app/desktop/desktopLink.ts` mirrors `theia/studio/src/common/desktop-link.ts`:
  the desktop hand-off, `ide-theia`'s desktop part.
- `kit_registry/builtin/ide.kit.json`: slug `ide`, the project tab `/space`
  on `space-mfe`. It names no runtime; it gains `requires` one.

### Risks and open questions

1. **Shared sessions in VS Code.** openvscode-server is one person per
   server: one connection token, one extension host env. P2 runs one
   session per (workspace, person). Is that acceptable for the teams that
   want VS Code, or must ADR-0030's shared session reach VS Code too (a
   patched server, or an extension host per person behind the gate)?
2. **The LLM token in VS Code.** Theia passes the member's own Studio token
   per request (`agent-credentials.ts`). VS Code's Claude Code and Codex read
   a key from env or their own login. In a one-person session the backend
   could mint a short-lived, workspace-scoped token for the broker and the
   extension could refresh it, but that puts a personal credential into the
   container, against ADR-0030 §1. Which do we accept?
3. **openvscode-server or code-server.** openvscode-server is closer to
   upstream; code-server has more hooks (its own auth, proxy). Pick one for
   P2?
4. **The gate's script injection.** Acceptable as the way VS Code hears the
   portal, or should portal opens go through the backend's control channel
   only (slower, one more hop, no `postMessage` at all)?
5. **How far P3 goes.** Items 1–5 or the whole list? Gearbox Studio and the
   Theia AI agents may stay Theia only; is a VS Code deployment without them
   a product we ship?
6. **The desktop in a VS Code deployment.** Keep offering the Theia desktop
   app there, or plan a VS Code desktop (the member's own VS Code plus our
   extensions)?
7. **Microsoft's marketplace.** openvscode-server uses open-vsx; some
   extensions people expect (Pylance, the C# Dev Kit, Live Share) are not
   there and may not be installed from Microsoft's marketplace by licence.
   Is that a blocker for the teams asking?
8. **Two images in CI.** The build and the Trivy scan double for the IDE
   layer; who owns the VS Code image's updates?

## Traceability

- Port in the core: `studio-backend/src/ide_bridge.rs` (today),
  `studio-backend/src/ide_runtime.rs` (P1).
- Session: `studio-backend/src/studio_session/`.
- Theia kit gear: `studio-backend/src/studio_theia/`.
- Kit manifest: `studio-backend/src/kit_registry/builtin/ide.kit.json`.
- Ratchets: `studio-backend/src/assembly/core_kit_allowlist.txt`,
  `studio-frontend-prototype/src-app/app/shellNamesNoKit.test.ts`.
- Frame channel: `studio-frontend-prototype/src-app/app/mfe/editorBridge.ts`,
  `theia/studio/src/browser/portal-bridge-contribution.ts`.
- Contract v1: `docs/theia-bridge-contract-v1.md`.
