# 2026-11-24 — fork main: Research deploy, organization scope, GitLab

Development runs in the fork `AndrejK666/studio-web`, whose `main` is the
trunk; nothing goes upstream until we decide so. Code is written first and
committed "(not gated)"; one combined gate runs on the fork's main at the end,
then failures are fixed per area. Priorities: **P0** blocks the Research
end-to-end deploy or leaves main broken, **P1** is needed to call the work
done, **P2** can wait.

## P0

- [x] Run the combined gate on the fork's main @andrejk666

  Done 2026-11-24 by claude-0e on 13cbcce78 (main after it is docs only):
  backend 3411/3411, contract, docs, API usage, portal lint/types,
  product-mfe 549/549. Red and not new: 10 projects-mfe timeouts (as on the
  old main) and the shell's `editorSessionEffects` (broken by 8fe24027b,
  see P1 below).

  Everything since 2026-11-23 is ungated: the GitLab connector and sign-in,
  artifact-ingest in the project's organization, organization-filed runs
  (find, cancel, retry), deployment logs and status by project, lost Research
  builds, the chunked rehome, the release map. Run
  `scripts/backend-gate.sh` (one slot; never two Rust builds at once), the
  prototype's per-package unit suites, `node scripts/check-api-usage.mjs` and
  `node scripts/check-docs.mjs`. The stabilization session (claude-0e) agreed
  that whoever merges last runs it; agree who before starting. Failures in
  these areas are mine: `connectors/gitlab`, `user_profile/gitlab_avatar`,
  `artifact_ingest` (sync, outputs, `org_scope`), `tasks/rest.rs` `find_run`,
  `connectors` and `git_proxy` run scoping, `environments` (research,
  secret_preflight, build_records, service_research_builds, deployment
  logs/status), `domain_model` rehome, releases-mfe, `LoginScreen`.

- [x] Regenerate the API contract @andrejk666

  Done in 4fdc9d2e8: `api-contract.json` and `api-contract-accepted.txt`
  regenerated in the gate container, the content route added to the
  typed-response baseline.

  `docs/api-contract.json` was edited by hand for the GitLab routes
  (`GET /studio-artifact-ingest/v1/outputs/{output_id}/content` and others).
  Check whether 4fdc9d2e8 already regenerated it; if not:
  `cargo run --locked --quiet -- api-contract > docs/api-contract.json && cargo run --locked --quiet -- api-contract --accept`
  inside the gate container.

- [ ] Find why postgres and studioweb-frontend fail in Research @andrejk666

  Deploy 48d74242 (build `research-7a977fac4b5a` to environment
  `research-hyp3099-git-pull-test`, 6d8703d1) got past api-gateway, which had
  failed before, but `postgres` and `studioweb-frontend` ended `failed`.
  Research gives Studio no container log and no reason
  (`/deployments/{id}/logs` returns three empty containers). Read the
  services' events/logs in the Research UI (project `hyp3099-git-pull-test`).
  Suspects: postgres without its password variable or with a volume it
  cannot write; the frontend's nginx not resolving `api-gateway`, or a
  non-root container binding port 80. Fix in the build (Dockerfile, chart
  values) or in `environments/research.rs`, then deploy only (no rebuild):
  `POST /studio-environments/v1/builds/research-7a977fac4b5a/deploy?project_id=d5e76267-60e3-4153-8e60-d4d8753ed01e`
  with `{"environment_id":"6d8703d1-9125-4ab5-bb97-8a919b8933d8"}`.

- [ ] Rebuild the stand from the fork's main and check what landed after it @andrejk666

  The stand runs `local-8fe24027b`. Rebuild with `bash local-stand.sh`
  (frontend only: `docker compose -p studio build frontend-prototype && docker compose -p studio up -d --no-deps frontend-prototype`;
  restart the portal after a backend restart, its nginx keeps the old IP).
  Then check:

  - the rehome on project d5e76267 (~19k objects) logs "rehome moved N of M"
    and ends; before it died on `graph-storage node batch ingest: deadline_exceeded`
    and left the root copies live;
  - `research-e684c390ab39` (stuck `running`, no images, no run) turns
    `failed` with "its run is gone" ten minutes after its start;
  - `/deployments/{id}/logs?project_id=` and `/status?project_id=` answer a
    platform admin (they 404'd without `organization_id`);
  - a platform admin's sync of an organization's repository shows progress
    to the end, survives a page reload, and can be cancelled and retried.

- [ ] Check the gears-matcher with LiteLLM on the stand @andrejk666

  Fork main has TK's LiteLLM provider (fork PR #2) on our run settings: a run
  may choose `options.provider` (`litellm`: glm-5.3-flash x3, `openai`:
  gpt-5.4/gpt-5.5/gpt-5.4), the choice replaces the settings' provider and
  models, the call bounds stay the settings'. The stand's `gears-matcher`
  container (`gears-matcher:local`, :8096) already runs it; LiteLLM shows as
  unavailable until `litellm_api_key` (from the gateway's owner) is in the
  container's `config-openai.toml`. Check Organization › Gears matcher in the
  portal (LiteLLM in the list, switch, save) and one run on each provider.

- [ ] Roll the gears-matcher out to Dev @andrejk666

  After the stand check. By hand, as in deploy-without-GitHub: build the image
  from fork main, push to `ghcr.io/andrejk666/studio-web/gears-matcher`,
  `helm upgrade gears-matcher deploy/helm/gears-matcher` with the `ghcr-pull`
  secret, and the LiteLLM key in the config Secret. Deploy backend and
  prototype from the same main together (the backend's settings proxy and the
  portal screen). `gears-matcher.yml` cannot publish to the fork's registry
  yet.

## P1

- [ ] Turn on deployments in the second Research project @andrejk666

  Deploy cc93c9c4 (environment 3847d98c, Research project
  `studioweb-research-example-project`, connection b06fa371) failed: Research
  refused to turn on the project's deployments ("Insufficient permission"),
  and two secret values became plain environment variables. Turn deployments
  on by hand in Research, or with an account that may. Open question: should
  Studio turn them on itself before a build, and refuse early when it may not?

- [ ] Secrets in Research are plain variables @andrejk666

  Research's public API keeps no secret variables, so every secret
  (4 in deploy 48d74242) is visible to whoever can open the service. Decide:
  accept and say so in the deploy dialog, or ask Research for secret
  variables.

- [ ] GitLab sign-in on the stand @andrejk666

  Code is in (`5b1432b73`: `keycloak/GITLAB_SSO.md`, the
  `keycloak-gitlab-idp` compose service, the Helm job `gitlab-idp-job.yaml`,
  `keycloak.gitlabIdp` values, the button in `LoginScreen.tsx`). Needs a
  GitLab OAuth application: redirect
  `https://localhost:8443/realms/studio/broker/gitlab/endpoint`, scopes
  `openid profile email read_user`. Put its id and secret into
  `STUDIO_GITLAB_IDP_CLIENT_ID` / `STUDIO_GITLAB_IDP_CLIENT_SECRET` (and `STUDIO_GITLAB_IDP_BASE_URL` for a self-hosted GitLab), set
  `STUDIO_GITLAB_SIGN_IN=1`, then sign in and check the avatar
  (`user_profile/gitlab_avatar.rs`).

- [ ] Try the GitLab connector on a real GitLab @andrejk666

  `c024cd710` ported Insight's connector and added writes (commits,
  branches, merge requests, statuses), releases, artifacts and the avatar.
  Only mocks have run it. Connect a GitLab project, sync it, read a merge
  request and a pipeline, download an output, open a merge request from
  Studio. Self-hosted GitLab on a private address needs `url_guard`
  `private_hosts`.

- [ ] Tell the stabilization session what is ungated @andrejk666

  Messages to claude-0e expire unread (the two sessions run in different
  permission modes). Pass it by hand: the list under "Run the combined gate".

- [x] Fix the shell's `editorSessionEffects` test @andrejk666

  Red since 8fe24027b (follow a run the event stream never mentions). The
  test expects the old behaviour; update it or the effect.

  Fixed by f128a5ca7 (the test's stream now mentions the run); confirmed
  green 2026-11-27 on 8d4bbf80d with the whole shell suite (1038 passed, 1
  skipped) after the overlayContract labels and the two cold-import timeouts
  were fixed on `AndrejK666/fe-test-debts`.

- [ ] Point `gears-matcher.yml` at the fork's registry @andrejk666

  The workflow publishes only to upstream's registry, so the matcher goes to
  Dev by hand. Add the fork's `ghcr.io/andrejk666` as a target, or a manual
  dispatch input for it.

## P2

- [ ] Purge the root's deleted copies @andrejk666

  The rehome marks moved root copies `_deleted` but keeps them. A one-time
  migration could remove them once the rehome has finished everywhere.
  Proposal only; not built.

- [ ] Portal nginx keeps the backend's old address @andrejk666

  After a backend restart the portal answers 502 until it restarts too.
  Resolve the upstream per request (a `resolver` plus a variable in
  `proxy_pass`).

- [ ] Rotate the GHCR token @andrejk666

  The PAT used for `ghcr.io/andrejk666` (deploy without GitHub) has been
  passed around; issue a new one and update the `ghcr-pull` secret.

- [ ] Kit gears at run time: answer ADR-0077's open questions @andrejk666

  `docs/design/kit-gears-at-runtime.md` ends with five questions; the ADR
  stays proposed until they are answered.

- [ ] Gears as packages: the pilot @andrejk666

  ADR-0078 and `docs/design/gears-as-packages.md` (with its inventory)
  describe publishing gears as packages and a platform release as a BOM
  version. Pick one gear and publish it from the forks of gearbox and
  gears-rust. Not started.

- [ ] Decide on the old branches @andrejk666

  Not on the fork's main: `AndrejK666/domain-read-model` (draft #892,
  ADR-0051, last 2026-10-28), `stand-tracks` (+198), `two-tracks-ingest-local`,
  `two-tracks-session-clone` (2026-11-13), `domain-diagram-all`
  (`docs/domain-model.md`, 2026-10-16, likely stale). Merge, rebase or delete.

- [ ] Tell TK what changed in their LiteLLM PR @andrejk666

  Fork PR #2 merged with our run settings: `options.model` is refused (models
  are fixed per provider), a run's provider wins over the settings but not
  their call bounds, `GET /v1/info` lists `providers`; their portal changes
  (projects-mfe Gears section, vite proxy, litellm icon) were not taken.

# 2026-10-15 — the project, its product, and where gears come from

What #716, #742, #756, #774 and the combined #789 leave open. The designs:
`docs/project-and-product.md`, `docs/project-domain-model.md`, ADR-0044, ADR-0045,
ADR-0046.

- [x] Put main's tip on Dev @andrejk666

  Dev runs ebf17a3b (helm revision 151, 2026-10-15): #742, #743, #727, #741,
  #756, #765 and #772. The runners queued for hours that day; the manual helm
  recipe deployed it.

- [ ] Move Dev off the fork's gear corpus @andrejk666

  After #774 is deployed, connect the platform's gear repositories in
  Platform › Sources: the fork `MikeFalcon77/gears-rust` at `feature/gearbox`
  until constructorfabric/gears-rust#4793 merges, then
  `constructorfabric/gears-rust` at `main`. Then drop `corpusUrl` from
  `values-dev`. #4793 waits on its author: it is 216 commits behind main, and
  the merge breaks four things (reviews on #4793); an offer to open the merge
  as a PR into `feature/gearbox` is in the review.

- [ ] Look at #716, #742 and #756 on Dev's real data @andrejk666

  - The Domain model tab on Insight: Glossary, Work, Against the code. Note
    the noise -- subjects that should not be entries, work linked by an id it
    only quotes, `product.missing` for a capability the code has under
    another name -- and tune the rules before anyone else reads them.
  - The Builds tab: a connection without Actions read shows "Studio could not
    read the CI runs of …"; give the token that scope.
  - The readiness check before Extract, and the organization's gears on the
    project's Product tab.
  - The Components readiness block in a running IDE (#510).

- [ ] The rules that need a model key @andrejk666

  Each waits for an Anthropic key on the stand (a workspace with a spend
  limit; the key goes into the portal, never into the chat or a file in the
  repository):

  - `code.*`: entities and values the documents name, against the code's
    identifiers, read through the glossary.
  - Proposed work links: work that names no identifier gets a proposed
    requirement, decided by a member like a finding. Projects without
    `**ID**:` labels (plain `FR-12`) have no links until then.
  - Goals, risks and open questions as facts of the domain model.
  - The provider-key flows (#699/#700) with a live key.

- [ ] The rest of the project's words @andrejk666

  - `writing.long_noun` (a stack of nouns in a requirement) is not built.
  - The assistant's instructions do not carry the writing rules yet, so what
    it writes into a document is not held to them.
  - Writing hints show only in the Documents perspective (TipTap); the
    Workbench perspective opens markdown in MDXEditor, which has none.

- [ ] Ask the Gearbox engine for what several gear repositories need @andrejk666

  - Honour `use_gear(source = …)`: it is parsed and not read, so a gear id
    declared in two repositories resolves by root order, not by the product.
  - GBX0105 (a gear declared twice) names both roots.
  - Release binaries and tags (gearbox#6): the crate version has stayed
    `0.1.0` across every commit; Studio now shows `0.1.0-<commit>` from the
    image.

- [ ] "Get protoc" on an installed Windows desktop @andrejk666

  #717 fetches protoc 36.2 into `~/ConstructorStudio/tools` and hands Build and
  Run `PROTOC`. Not yet tried in an installed desktop build on a machine
  without protoc. #718 was closed as its duplicate.

# 2026-09-29 — desktop 0.3.0-beta.5

What the release leaves open (its notes: `docs/desktop-release-notes.md`):

- [x] A landing page, and the Studio view in order @andrejk666

  The placeholder folder shows a landing page with Connect, the modes and
  Work offline (#511); the Constructor Studio view has an account block, the
  open project's card and a tree (#492); both call one client (#527); the
  update channel is a setting (#506).

- [ ] The portal link handler calls the shared desktop client @andrejk666

  `desktop-link-handler.ts` still makes its own `/studio-desktop` calls (open,
  environment, sign-in), reads an error body without a catch, and announces
  nothing, so the landing page and the view learn of a link-driven change on
  their next poll. Left by #527. #533.

- [ ] Run Build and Run end to end on a Windows desktop with MSVC @andrejk666

  #514 checked the toolchain probe on a machine without the MSVC linker and
  the local Postgres against docker, not a generated product built and run on
  a machine that has the Build Tools. #534.

- [x] A per-machine catalogue cache for the Gearbox engine @andrejk666

  The cold wait was Defender scanning the corpus file by file. #538 reads the
  corpus ahead in parallel, keeps the engine for a second open and caches the
  catalogue on disk: a cold open takes 10-20 s instead of 64-90 s. Handing the
  engine a saved catalogue needs MikeFalcon77/gearbox#5. #535.

- [ ] Gearbox engine bugs, worked around in Studio until the engine fixes them @andrejk666

  - `add_source` breaks a product `product/create` wrote (GBX0101); Studio
    closes the source list first (`node/sources-list.ts`).
    [gearbox#1](https://github.com/MikeFalcon77/gearbox/issues/1)
  - A scaffolded gear is not catalogued, and a corpus host's plugin cannot be
    scaffolded; New Gear says so.
    [gearbox#2](https://github.com/MikeFalcon77/gearbox/issues/2)
  - `gearbox generate` from the CLI on Windows writes `\\?\C://` paths;
    Studio's RPC path is not affected.
    [gearbox#3](https://github.com/MikeFalcon77/gearbox/issues/3)
  - The generated config has no database section; Run writes
    `config/<app>.local.yaml`.
    [gearbox#4](https://github.com/MikeFalcon77/gearbox/issues/4)

  Drop each workaround with the engine pin that fixes it.

- [x] Point dev's Gearbox corpus at constructorfabric/gears-rust @andrejk666

  Superseded: the corpus is the platform's gear repositories now (ADR-0046);
  see "Move Dev off the fork's gear corpus" under 2026-10-15.

- [ ] After the weftgraph deploy on studio-dev @andrejk666

  ~~Update the stored edge types with `scripts/graph-storage-update-edge-types.sh`
  and then drop the script (#532)~~ -- done in #966: the in-process
  registration passes `on_existing: update`, and the script is gone. Drop
  `outbox_repair` once toolkit-db upgrades old outboxes itself (#531). From
  #512 and #521.

- [ ] Look at the Components readiness in a running IDE @andrejk666

  #510's Readiness block and row facts were unit-tested, not seen in a
  session or on a desktop; dev after the deploy is the first place.

# 2026-09-29 — the desktop's tools as extensions (ADR-0032)

What was built today, and what it left open:

- [x] Ship `cfs` to the desktop @andrejk666

  The Constructor Studio CLI is the extension `constructorfabric.studio-cli`,
  with its own Python, home and pinned engine (#505).

- [x] The standard Extensions view, open to all of open-vsx @andrejk666

  Claude Code and Codex are no longer pinned; they install from open-vsx on
  first start and are the member's from then on (#513).

- [x] Kits in the Extensions view @andrejk666

  Installed into the open checkout, and reported through
  `POST …/installations/{kit}/materializations` (#517).

- [x] The gearbox engine out of the installer @andrejk666

  The extension `constructorfabric.gearbox-engine`, built once per pinned
  revision (#519).

- [x] Uninstalling on Windows finishes @andrejk666

  An extension of Theia's deployer handler stops what runs from the folder and
  leaves what is still held for the next start (#522).

- [ ] Install a kit end to end from a signed-in desktop @andrejk666

  Needs a Studio running #517's backend: request → `cfs` in the checkout →
  the portal's row shows *installed* for that repository.

- [x] Pin the session's `cfs init` to its engine @andrejk666

  The image records the engine it cached in `/opt/cfs/cfs.json` and names
  it in `STUDIO_CFS_PIN`; `cfs` from PATH reads it, so `cfs init` gets
  `--version` in a session as on the desktop. Measured on the image: unpinned,
  the first init moved the cache from v1.6.2 to v1.7.0.

- [ ] Publish the CLI and the engine on open-vsx @andrejk666

  Until then the view lists them as built-in and they update only with a new
  app build. Needs a `constructorfabric` namespace and a publishing token.

- [ ] Build the CLI and the engine for macOS and Linux @andrejk666

  `cfs.json` pins a Python for `linux-x64` and `darwin-arm64`; the workflows
  build `win32-x64` only, as there is no macOS or Linux desktop yet. The
  store's unpack keeps no exec bit, which a POSIX target will need.

# 2026-09-29 — agent development (Orca) on the desktop

What #496 left open when it made Orca discovery, states and worktree scoping
right on the desktop:

- [x] Decide whether the open project's repositories go into Orca automatically @andrejk666

  Decided (#497), built in #499: Studio asks once — always / not now / never
  (`studio.orca.addOpenedProjects`, changeable from the Agents panel) — and
  when a project closes it removes from Orca only the repositories Studio
  added itself, never while an agent is running or changes are uncommitted.

- [ ] Pair with the local Orca without pasting a link @andrejk666

  Orca has no CLI for handing out a pairing, so the member copies a link from
  Orca into Studio. Needs an upstream change in Orca. #493.

- [ ] Check Orca discovery on real macOS and Linux machines @andrejk666

  The install locations for macOS (`/Applications/Orca.app`, `/usr/local/bin`,
  `/opt/homebrew/bin`, `~/.local/bin`) and Linux (the .deb and the AppImage's
  `~/.local/bin/orca-ide`) come from Orca's code and are tested only on
  Windows; there is no macOS or Linux desktop build yet. #494.

- [ ] Ask Orca which agents it can start @andrejk666

  The desktop lists claude, codex and opencode by what is on the PATH the IDE
  sees, which is not the PATH Orca starts agents with. #495.

# 2026-09-24 — the desktop Studio (ADR-0027)

Phase 1 is #391 and the installer is its follow-up (`docs/desktop-studio.md`).
What was left out on purpose, or worked around to get a binary on one machine:

- [ ] Code-sign the Windows installer @andrejk666

  The installer is unsigned, so SmartScreen stops the first run ("More info" →
  "Run anyway"). Signing needs a code-signing certificate and a secret for
  `desktop.yml`; electron-builder signs when `CSC_LINK` /
  `CSC_KEY_PASSWORD` are set.

- [ ] Sign and notarize the macOS app with a Developer ID @andrejk666

  The Mac build (`desktop.yml`, `macos-15`) is signed ad hoc: Gatekeeper asks
  the member to allow it once, and it cannot update itself (Squirrel.Mac needs
  matching signatures), so it points to the release page instead. With an
  Apple Developer ID, set the secrets `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`
  and `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; the workflow
  passes them on and `package.mjs` then signs, notarizes and updates in place.

- [x] Hand out installers from CI only @andrejk666

  Done: `desktop.yml` builds on `windows-2022` and `macos-15`, and every
  `desktop-v*` tag publishes the installers as a GitHub release.

  The first binary was built on a developer machine without MSVC:
  `node-pty` and `keytar` from their N-API prebuilds, `native-keymap` and
  `windows-ca-certs` copied from a VS Code install, and `drivelist` — which has
  no win32 prebuild anywhere — replaced by a stub, so file dialogs list no
  drives. None of that is in the repository; the `windows-2022` job compiles all
  of them. Publish its artifact (a GitHub Release per tag) and stop passing
  local builds around.

- [ ] Keep the sign-in across restarts @andrejk666

  The token lives in the IDE backend's memory, so every start signs in again.
  ADR-0027 §2 keeps the refresh token in the OS keychain through Electron's
  `safeStorage`; that part is not built.

- [x] Automatic updates @andrejk666

  Done: the app updates from the rolling `desktop-updates` release, *Help →
  Check for Updates* (#452), and stable or beta as a setting (#506).

  An installed build never learns there is a newer one. electron-updater
  against the releases above; decide the channel (one per stand, or one
  build that offers every stand, which is what `environments.json` already
  does).

- [ ] Add the `studio-desktop` client to every running realm @andrejk666

  A realm file is imported only when the realm is created, so an existing stand
  needs the client imported by hand (`docs/desktop-studio.md` → "What a Studio
  deployment needs"). Done on dev; **test still answers "Client not found"**.
  Better: make the realm bootstrap reconcile clients instead of importing once.

- [ ] Deploy `studio-git`, so a workspace opens from the desktop @andrejk666

  Until #391 is deployed, dev and test sign in and list workspaces but answer
  "cannot clone for a desktop yet". A merge to `main` does not build by itself —
  dispatch "Studio Delivery" afterwards.

- [ ] Build and try macOS and Linux @andrejk666

  `package.mjs` names dmg and AppImage targets; neither has been built. Needs a
  macOS runner (and notarization) and a Linux job.

- [ ] Unpin `windows-2022` @andrejk666

  `windows-latest` moved to Visual Studio 2026, which the node-gyp 10.x in
  theia's tree cannot find. Move the job back when the tree's node-gyp knows it.

- [x] Make the desktop look like a desktop @andrejk666

  Done: a landing page instead of the product's start page in the placeholder
  (#511), the Studio view reworked (#492), and the Agents panel's desktop
  states, without the session's image advice (#496).

  The window still carries session furniture: `product-ext`'s welcome page and
  an Orca panel that reports a runtime this machine may not have, and the
  Studio view is narrow enough to wrap every line.

- [x] Open a project from the portal in the local desktop Studio @andrejk666

  Done: `cfstudio://open?studio=…&issuer=…&project=…&name=…` (#419), and the
  portal's IDE card offers Desktop IDE (#447).

  A separate track. Today a member starts the desktop app, signs in and picks
  a workspace in its own Studio view. The portal should offer "Open in desktop"
  beside "Open Studio" and land them in that project in the app they already
  have installed (ADR-0027 §6):

  - the installer registers a `cfstudio://` protocol handler (electron-builder
    `protocols`), and the app handles the link on start and when already
    running (Electron `open-url` / second-instance);
  - the link names the Studio and the project,
    `cfstudio://open?studio=<url>&project=<id>`, and carries no token. The app
    switches to that Studio if it is one it offers (or asks first when it is
    not), signs in if it has to, and clones and opens the project through
    `studio-git` exactly as a click in its Studio view does;
  - the portal shows the button only when it can tell the app is installed.
    If it cannot, it shows "Get the desktop app" linking to the installer.

  Needs `studio-git` deployed (#391) for the clone, and the desktop installer
  (#395).

- [ ] ADR-0027 phases 4–5: events, commands @andrejk666

  Phase 3 is built: desktop leases, and the portal shows where a project is
  open (#450). Still open: the desktop's events do not reach the ingress, and
  the portal cannot send it a command. The ingress's desktop authentication
  path, and commands over `studio-events`.

# 2026-09-25 — "signed in as Vasil, and it was not Vasil"

Somebody was seen working as Vasil without being Vasil, and without ever
having used Vasil's browser. What the tests found, and what is still a
hypothesis:

- [ ] A shared IDE session acts as whoever launched it @andrejk666

  **Hypothesis for the incident, reproduced in a test.** `studio-session`
  keeps one session per workspace on purpose, so a second member does not
  destroy the first one's container (`two_callers_reach_one_workspace_session`).
  But a container is launched once, and its environment is built from the
  person who launched it: `STUDIO_ACTOR_ID`, the git author
  (`git_identity_env`), and the agent keys read from credstore under that
  person's identity, their private secrets first. The second member signs in
  to the portal correctly and holds their own token, and still commits, pushes
  and calls agents as the first, with the first person's keys.
  `studio_session::service::tests::the_second_member_of_a_workspace_does_not_work_as_the_first`
  reproduces it. It is `#[ignore]`d until this task is done: drop the ignore
  when it passes.

  **Still to confirm:** whether the incident was seen inside the IDE (commit
  author, agents, names in the IDE), which is this cause, or in the portal's
  user menu, which is not.

  **Direction:** several people in one container, each acting as themselves.
  Not one container per person. Roughly:
  - nothing personal in the container's environment;
  - the git author and the push credential per connection, from that
    connection's portal token (the credential helper asks the session gate
    who is typing);
  - agent and LLM calls through `studio-llm-proxy` under the caller's own
    token, instead of keys in env;
  - terminals and agent runs owned by the connection that started them;
  - `STUDIO_ACTOR_ID` replaced by the connection's identity wherever the
    Studio extension records who did something (journal, audit, presence).

  The Theia PoC was built single-user (ADR-0003 asked for one instance per
  user and workspace). **ADR-0030** (proposed) amends it: one container per
  workspace, identity per connection. What actually stands in the way:

  1. **Identity is baked into the environment at launch.** The git credential
     helper and the agent CLIs read it. Theia already has one plugin host per
     window (`HostedPluginProcess` in a `ConnectionContainerModule`), and its
     environment is extensible (`PluginHostEnvironmentVariable`), so identity
     can come from the connection. The portal already hands each window its
     own person's token.
  2. **One working tree for everybody:** one index, one branch, one set of
     uncommitted changes. A `git worktree` per person, as Orca already does
     per agent task.
  3. **One OS user for every process,** so members can read each other's
     `/proc/*/environ`, `~/.claude` and shell history. Keep nothing
     long-lived there and state the workspace as the trust boundary;
     per-person uids are a later step if that boundary must move.

  Phases in ADR-0030: no personal secrets in env (git through `studio-git`,
  models through `studio-llm-proxy`), then identity per connection, then
  "who did it" in the journal, audit and presence, then a worktree and a
  `HOME` per person.

  **Done (branch `AndrejK666/session-no-personal-env`):**
  - the session environment no longer carries the launcher's provider keys
    or git author (`a_session_carries_no_key_of_its_launcher`);
  - agents reach their models through `/studio-llm/v1/providers/*` on the
    caller's own key from their profile;
  - each window's Claude Code and Codex requests carry that window's person.

  **Done, phase 2 (#416):**
  - `STUDIO_ACTOR_ID` is Studio's service identity: the `studio-service`
    client's service account, which has no roles, no browser or password
    sign-in, and a subject fixed in both realm files. `studio-user` seeds it
    as "Constructor Studio (service)" with no membership.
  - `the_second_member_of_a_workspace_does_not_work_as_the_first` runs
    un-ignored.
  - On a realm that already exists (dev, test), import the `studio-service`
    client and set `backend.serviceSubject` to its service account's id.

  **Already there, and not to be duplicated:**
  `product-ext/src/node/viewer-credentials.js` gives each window's plugin host
  a `HOME` of its own through `PluginHostEnvironmentVariable`. That home holds
  its own `~/.claude`, its own `~/.codex`, and a `.gitconfig` with the portal
  viewer's name and e-mail. Per-window git authorship and per-person agent
  logins in the plugin host are therefore solved. A per-connection
  `GIT_CONFIG_GLOBAL` was tried and dropped: it made git skip that home's
  `.gitconfig`.

  **Still open:**
  - processes the Theia backend spawns (terminals, and Theia's own Claude
    Code / Codex services) keep the container's `HOME` and neutral git
    author. `viewer-credentials` reaches only the plugin host;
  - a terminal `claude` or `codex`, and Orca's agents, have no token yet;
  - repository tokens still come in `STUDIO_SOURCES` (workspace
    connections, not personal).

- [ ] Decide what "Continue with Constructor ID" does with a live browser session @andrejk666

  `keycloak/tests/account-takeover.test.mjs` shows it. A browser still signed
  in to Keycloak as somebody else, because they closed the tab without
  signing out, signs the next person in as them with no form shown, since
  neither portal sends `prompt`. Sign-out itself is right in both portals
  (RP-initiated logout). The same test clears the other suspects: an outside
  IdP account carrying the victim's e-mail, verified or not (nOAuth), gets
  asked for the victim's password. That holds for the realm as
  `keycloak/realm-studio.json` configures it; the dev and test realms were not
  read. The desktop already sends `prompt=login` (#395).

  Options: a "Continue as <name>? / Not you" step before the silent sign-in,
  plus a shorter SSO idle timeout on the realm (recommended); or `prompt=login`
  on every sign-in.

  The prototype now sends `prompt=login` on every redirect to the IdP; its
  password form never touched the cookie. `studio-frontend` still sends none.

# 2026-09-17

- [ ] Decide how a notification leaves Studio, then build it @andrejk666

  The collaboration work landed everything that keeps a conversation inside the
  product: threads that travel with the branch, who is waiting on whom, tasks in
  the documents, and all of it visible in the IDE and the portal. Requirement
  §10 of `studio-internal/requirements/studio-collaboration-comments-requirements.md`
  asks for the other half — *"you shouldn't have to go into the product to learn
  about comments"* — and that one is blocked on a decision rather than on work.

  Three ways, each of which adds a subsystem rather than a function:

  - **a project channel.** `studio-notify` already delivers to a chat connection
    with a queue, retries and a dead-letter table. What does not exist is any
    notion of *which* channel belongs to a project, so this starts with new
    configuration. Cheapest, and it is not a personal notification: the message
    says "three threads in X are waiting on Ana" to a room.
  - **personal e-mail.** `identity_directory::verified_email` is already "the
    only address in this system that may be decided from", and `studio-notify`
    already owns the queue. What is missing is a driver — there is no SMTP or
    e-mail provider anywhere in the backend. The only option that closes §10 as
    written, and the recommendation.
  - **a stored inbox.** Both gears refused this deliberately and said so:
    `studio-presence` is "a message is an event, not a mailbox", `studio-notify`
    delivers to a destination rather than to a person. It is the only one that
    answers "I was away yesterday".

  The trigger needs no new storage whichever is chosen: the previous
  `waiting_on` is on the repository node until the sync upserts over it, so
  reading it first and comparing is one extra read, and only an increase
  notifies.

- [x] Decide where `theia/product-ext` lives, rather than port it @andrejk666

  This was written as a port: the package was vendored from `studio-desktop`'s
  `app/product-ext`, its README said a change made only here was lost on the
  next sync, and most of what landed that day lived in it. What made it a debt
  rather than a task is that there was no sync — no `SOURCE.json`, no script,
  and the repository is not reachable from this account — so it was not a
  deadline anybody was keeping, it was one waiting for the next manual copy.

  Settled the other way instead: **the source lives here.** The three places
  that said otherwise now say that, and the package's README explains the one
  thing that looks like vendoring and is not — `flow-backend.js` probing for the
  MCP server under `lib/`, which is a packaged application's layout and must
  survive any later tidying.

# 2026-07-29

- [ ] Define the list of required Gears for Studio Cloud/Web v1 @artifizer
- [ ] Create domain-model folder and domain model definitions and playground @artifizer [#2](https://github.com/constructorfabric/studio-web/issues/2)

# 2026-07-28

- [x] Need to define repo structure to have both backend and frontend @artifizer
- [ ] To create initial v1 scope PRD @nrggit
- [x] Review gears-rust/ account-management gear and check if it has enough capabilities @andrejk666
- [ ] Theia review, ensure multi-user/multi-tenant source code management would work
