# Desktop Studio release notes

What a member notices in each release of the desktop Studio, and what is known
not to work yet. A release is cut from a `desktop-v*` tag; its GitHub release
page lists the merged PRs by title, generated, and this page says what they
change for the person using the app. How the app works is
[desktop-studio.md](desktop-studio.md); what is still open is
[TASKS.md](../TASKS.md).

Releases up to 0.3.0-beta.4 are described only on their GitHub release pages.

## 0.3.0-beta.5

Everything merged since `desktop-v0.3.0-beta.4`. The installer is Windows
only, as before.

### Desktop

- **A landing page while no project is open.** The app starts in a
  placeholder folder, and the product's start page used to read it as a
  project called "workspace". Now the main area says where you are and offers
  three things: connect to a Studio and choose a project, learn the modes (one
  card per mode, dismissed with **Got it**, back with **Help → Welcome**), or
  open a local folder and work offline. The "workspace source suggestion"
  notification no longer appears for the placeholder. (#511)
- **The Constructor Studio view is in order.** An account block (which Studio,
  who is signed in, **Switch Studio**, **Sign out**); a card for the project
  open in this window, with **Open in portal**; the projects as a tree that
  folds, filters and works from the keyboard. Organizations that share a name
  are told apart by the start of their tenant id. A project with no
  repositories says so before you click it, and a failed open is shown under
  its row rather than at the bottom of the panel. (#492)
- **The landing page and the view agree.** Both use one client and one Studio
  picker, so a sign-in, sign-out, Studio switch or open done in one shows in
  the other straight away. A refused sign-out or switch now says why instead
  of leaving the view stuck on "Loading your projects…". (#527)
- **The update channel is a setting.** The beta checkbox left the Studio view
  and is now **Settings → Extensions → Studio → Desktop: Update Channel**:
  `auto` (the default: betas for a beta install, releases for a release),
  `stable` or `beta`. A choice made in an earlier build is carried over once.
  **Help → Check for Updates…** is where it was. (#506)
- **The Extensions view.** The code modes have VS Code's Extensions view, open
  to all of open-vsx: search, install, update and remove any extension. (#513)
- **Claude Code and Codex are no longer in the installer.** On the first
  start the app installs the newest version of each from open-vsx, as your own
  extensions, and from then on you update or remove them in the Extensions
  view. One you remove is not installed again. While an assistant installs,
  the rail says so instead of "not available here". (#486, #513)
- **The Constructor Studio CLI arrives as an extension.** `cfs` is fetched on
  the first start, with its own Python and the skill engine the session image
  pins, so the traceability map, kit installs and the agents' Studio skills
  work on a machine with no Python or with its own `cfs`. IDE terminals find
  it first on their `PATH`; your own `~/.cf-studio` is left alone. (#505)
- **The Gearbox engine arrives as an extension** instead of being built into
  the installer. When it lands, the gear catalogue reloads by itself. (#519)
- **Studio kits in the Extensions view.** With a project open, the view lists
  the kits the project asked for (installed, failed with the reason, or not in
  this checkout yet) and the rest of the catalogue; `@kit` searches kits only.
  **Install** puts the kit into the open checkout with the CLI and tells the
  Studio, so the portal shows the same row a session install would. (#517)
- **Uninstalling an extension on Windows finishes.** Removing Claude Code used
  to hang at *Uninstalling* and the extension came back after a restart. The
  app now stops what runs from the extension's folder, offers **Reload
  Window**, and removes what was still in use on the next start. (#522)

### Doc editing and modes

- **"FULL SUPER POWER" is now "Full functionality"**, in the mode picker, the
  ribbon and the landing page's cards. A mode you had chosen stays chosen.
  (#518)
- **The ribbon says why an action cannot run.** An action that is registered
  but not available now is drawn disabled, with the reason in its tooltip
  ("Open or create a product first", "The Gearbox engine is not running"). A
  command that fails is reported instead of doing nothing. (#500)

### Building and Gearbox

- **Building works in a repository with no gears.** New Product offers the
  gear corpus as a source: the copy already on this machine, preselected when
  the workspace has no gears of its own, or **Bring the gears here** inline.
  A corpus copy on disk is offered even while signed out. Products under
  `<repository>/products/<name>/product.gdl` are found, which is where New
  Product suggests one. (#500, #502)
- **A private corpus is cloned through Studio.** The corpus's token stays on
  the server; the desktop clones through a relay with your Studio sign-in.
  (#487)
- **A product's `git(url, rev)` source opens anywhere.** The commit is brought
  into the per-machine corpus cache, through the relay when it is the corpus
  Studio serves, and never into your project. (#500)
- **Add gear with no product open opens New Product**, with a line saying why.
  (#500)
- **Windows fixes in the Add gear flow**: a product created in the window is
  found after a reload, the first open no longer times out behind a catalogue
  scan, typing in New Product's fields is no longer lost, and signing in with
  the window already open loads the backend's catalogue. (#502)
- **Apply changes / Discard.** Gear settings, features, plugin options and
  profile fields go into a draft, and a strip at the head of the Product view
  shows the pending count with **Apply changes** and **Discard**, next to the
  product's state (resolving, *N conflicts*, resolved), **Resolve** and
  **Close**. Before this, those drafts could not be written. (#514)
- **The Gearbox menu** (Add Gear, Resolve, Conflicts, Resolution Lock,
  Generate) appears in Building and Full functionality with a product open.
  Building's ribbon **Check** group reads Resolve, Conflicts, Lock, Generate.
  (#514)
- **With no product open, the Product view offers** Continue (the last
  product), New Product, Open Product, the workspace's products and Recent.
  (#514)
- **A closed product's panels go away**: when another product opens, the old
  one's Add Gear, Lock and Generate panels are withdrawn. (#514)
- **New Gear says what the engine will not do yet**: a scaffold is catalogued
  only once its `src/lib.rs` carries `#[toolkit::gear(...)]`, and a plugin for
  a corpus host has to live in the host's corpus, at the path it names. (#514)
- **Build and Run after Generate.** **Build** runs `cargo build`, **Run** runs
  the generated application with its configuration, each in one reused
  terminal per product, with the REST address and an **Open** button. A
  product whose gears need a database runs with a local configuration that
  adds a Postgres server, and **Start a local Postgres** starts one in docker
  when nothing answers on port 5432. A missing cargo or MSVC linker is said
  with a link, not a terminal error. (#514)
- **Opening a product shows progress** ("loading the gears it declares — 12 of
  44 gears") instead of sitting on "Reading the description…", and an open
  whose gears stop loading for two minutes stops with the reason and puts the
  previous product back. (#520)
- **Engine `55f7015`.** Relative destinations are refused, a host with an
  unfilled extension point is reported on resolve (GBX0511), and profile ids
  are checked. (#514)

### Agent development (Orca)

- **Studio finds Orca where members install it**: the per-user and
  per-machine Windows installs, the macOS app and *Install CLI* links,
  Homebrew, and the Linux packages and AppImage, before `PATH`. Installing
  Orca while Studio runs needs **Refresh**, not a restart. (#496)
- **Every state says what to do**: **Get Orca** when it is not installed,
  **Start Orca** when it is closed, **Pair with Orca** when terminals need a
  pairing, and a new pairing offered when Orca no longer accepts the old one.
  On the desktop the panel no longer says "Not in this image"; agents Studio
  cannot see on its `PATH` are a hint, and all stay on offer. (#496)
- **Worktrees are grouped by repository**: the open project's first, the rest
  under **Other repositories in Orca (N)**. A new task goes to the selected
  worktree's repository. (#496)
- **Studio asks once before adding a project to your Orca**: *Always add*,
  *Not now* or *Never*, kept as the setting `studio.orca.addOpenedProjects`
  and changeable from the Agents panel. When a project closes, Studio removes
  from Orca only the repositories it added itself, and keeps any with a
  running agent, a running terminal or uncommitted changes. Nothing on disk is
  deleted. (#499)

### Components

- **One components reference in the IDE.** Building → Corpus → Components
  lists the portal's catalogue and the Gearbox engine's gears as one list,
  joined by crate name, with search, kind and category filters, a detail pane,
  and **Add to product** for a gear the engine can add. (#503)
- **One kind and one category vocabulary.** Every entry has one kind (gear,
  plugin, SDK, library, micro-frontend, frontend library, tool, kit) and one of
  the platform's seven categories, each with the evidence it was decided
  from. Config, test-support, example and template crates are no longer listed
  as components, duplicates and guessed crate names are gone, and a warm read
  of the list takes milliseconds instead of seconds. (#507)
- **Readiness on the portal's cards.** A gear's stage, milestone and due date,
  whether the date is committed, progress, who needs it, and whether the plan
  meets the demand, read from the platform's roadmap board and from the
  repository itself. Only facts that have an answer are shown. (#509)
- **Readiness in the IDE.** The same stage, schedule and demand in each row of
  the Components view, and a Readiness block at the top of a component's page.
  (#510)
- **A quality grade per component**, A to E, from 24 rules in six areas, with
  what would raise it. On the portal's cards and component page, and in the
  IDE. (#516)
- **The Components page's Sources** names the roadmap board that readiness
  came from. (#515)

### Portal and backend

- **Gearbox on the cluster, on for dev.** The backend image carries the
  engine, and the chart's `backend.gearbox` (off by default, on in the dev
  example) turns on the backend's catalogue, product previews and the corpus
  relay. On dev, Building's catalogue is no longer empty in a repository with
  no gears. (#490)
- **Every gear from crates.io.** The backend takes all its gears from
  crates.io, the graph-storage gear as `weftgraph` 0.1.1, and moves to toolkit
  0.10. (#512) An existing environment needs the fixes of #521 on the way:
  the database bootstrap repairs outboxes an older toolkit created, a finished
  task run no longer blocks the runs behind it, a refused graph write logs its
  reason, and `scripts/graph-storage-update-edge-types.sh` updates stored edge
  types once after the deploy. (#521)
- **A file opens in the portal's editor screen**, and the address carries it,
  so Back, Forward and reload return to it. (#459)
- **The IDE talks only to the portal its session names.** The editor accepts
  portal messages only from an allowed origin and may be framed only by it
  (#491), and a write from another origin is refused, as a WebSocket already
  was (#501).
- **Builds**: `npm run lint` lints again and CI runs it (#442); duplicate fork
  builds and stale desktop runs are cancelled (#488); the file-storage sidecar
  builds from crates.io and is cached (#523, #524); the Theia image layers and
  the desktop build's Electron downloads are cached (#526).

### Known limits

- **Build and Run need a Rust toolchain.** On Windows that is cargo and the
  MSVC linker from the Visual Studio Build Tools; **Start a local Postgres**
  needs docker. Build and Run were checked on a machine without MSVC, where the
  panel correctly says the linker is missing, and have not been run end to end
  on one that has it. A portal session has no Rust and says so. (#514)
- **The first open of the gear catalogue is slow on Windows.** A cold open
  took about 90 seconds on a Windows machine (7 seconds warm) while the engine
  reads the 44-gear corpus. The open now shows how far it has got instead of
  looking hung. (#502, #520)
  <!-- TODO(catalogue-cache, #535): a per-machine catalogue cache is in progress; when its PR lands, replace this item with what it changes and its PR number. -->
- **The first start downloads the tools.** Claude Code and Codex come from
  open-vsx (together a few hundred MB), the CLI (22 MB) and the Gearbox engine
  (about 6 MB) from GitHub releases. Until then the rail's assistants say they
  are installing and the catalogue says there is no engine. The downloads do
  not use the system proxy. (#486, #505, #513, #519)
- **Assistant versions are no longer pinned.** The desktop's Claude Code and
  Codex are whatever open-vsx had when you installed or last updated them, and
  may differ from the session image's. The CLI and the engine are pinned, and
  update only with a new app build. (#513, ADR-0032)
- **Gearbox engine bugs, each worked around in Studio until the engine fixes
  it**: adding a source to a product New Product wrote breaks it (GBX0101,
  [gearbox#1](https://github.com/MikeFalcon77/gearbox/issues/1)); a scaffolded
  gear is not catalogued, and a corpus host's plugin cannot be scaffolded
  ([gearbox#2](https://github.com/MikeFalcon77/gearbox/issues/2)); `gearbox
  generate` from the command line on Windows writes `\\?\C://` paths, which
  Studio's path does not hit
  ([gearbox#3](https://github.com/MikeFalcon77/gearbox/issues/3)); the
  generated configuration has no database section
  ([gearbox#4](https://github.com/MikeFalcon77/gearbox/issues/4)). (#514)
- **A product built on the corpus copy resolves only on this machine.** New
  Product declares the copy as an absolute `path(...)`, because the engine
  writes path sources only. Declare the corpus as `git(url, rev)` to share the
  product. (#500)
- **A kit has not been installed end to end from a signed-in desktop.** The
  steps are tested one by one; the whole path needs a Studio running #517's
  backend. (#517)
- **Orca**: pairing is still a paste (#493); discovery on macOS and Linux
  comes from Orca's code and has not run on either (#494); the agents on offer
  are what the IDE's `PATH` has, not what Orca can start (#495); removing a
  repository from Orca on close was read from Orca's code, not run against a
  member's Orca. (#499)
- **Components**: reading the roadmap board needs a GitHub connection that can
  read organization projects (#509); the IDE's readiness block has not been
  looked at in a running IDE yet (#510); the data-quality fixes of #503 and
  #507 take full effect after the next Components sync.
- **Tested by parts, together for the first time here.** The Studio view,
  the landing page, the update channel, Orca discovery and the ask-once
  setting, and most of the Building changes were verified with unit tests,
  headless renders and the real engine, but not in a rebuilt desktop app
  before they merged (#492, #496, #499, #500, #502, #506, #511, #514). This
  beta is the first build that carries them all.
- **Still true from earlier betas**: the installer is not code-signed, so
  SmartScreen asks before the first run; there is no macOS or Linux build; the
  sign-in does not survive a restart.
