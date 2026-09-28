# The desktop Studio

The desktop Studio is the IDE running on a member's own machine, as an
installed application, and connected to a Studio deployment — dev, test, a
local stack, or any other. It is the same Theia application a session runs in
a container (`theia/electron-app` has the extensions of `theia/browser-app`),
with one difference that decides everything else: the backend did not start
it, so nothing on the member's machine may hold a secret of the
organization's. [ADR-0027](adr/0027-a-desktop-session-keeps-the-secrets-on-the-server.md)
is the decision; this page is how to build, configure and run it.
Changing it? [desktop-contributing.md](desktop-contributing.md) has the rules.

What a member does:

1. Starts **Constructor Studio**, picks the Studio in the **Constructor
   Studio** view (Dev, Test, Local, or an address), and clicks **Sign in with
   Constructor ID**.
2. Signs in on the realm's own page, in the system browser. The app waits on a
   loopback port and takes the answer.
3. Sees the projects they can reach — found the way the portal finds them:
   the organizations they are a **member** of (`studio-user`
   `/me/memberships`), and each one's `workspace` tenants, which the portal
   calls projects — and clicks one to open it: its sources are cloned through
   the Studio and the folder opens in the IDE. The organization is named only
   when there is more than one, as the portal hides it.

## One IDE, two hosts

`theia/studio` and `theia/product-ext` are the **same code** in the portal's
session (`browser-app`, in a container, the portal hands it a token) and on the
desktop (`electron-app`, the member signs in here). Every desktop change has to
leave the web session exactly as it was. What keeps them apart today:

- The backend's `DesktopStudioContribution` mounts `/studio-desktop/*` and its
  `/studio-api` proxy **only** when a Studio is configured
  (`STUDIO_DESKTOP_URL` / `_ENVIRONMENTS`). A session image sets neither, so
  there the routes do not exist and the session gate keeps serving `studio-api`.
- The frontend opens the Constructor Studio view only when
  `studio-desktop/status` answers `enabled`; in a session that request 404s and
  the view never shows.
- Desktop-only logic lives in `desktop-*` files (`desktop-studio-widget.tsx`,
  `desktop-projects.ts`, `node/desktop-*.ts`). Shared widgets call Studio
  through `StudioApi.fetch('/<gear>/v1/...')` and must not care which host
  answers it.

So, when improving the desktop:

1. Branch on the host by the status (`enabled`), never by `process.versions.electron`
   or a build flag — the same bundle is tested in both.
2. Do not change what a shared widget asks for to suit the desktop; add to the
   desktop proxy instead.
3. Before merging, open a portal session as well as the desktop app: the
   Documents, Sources and Analyze views must behave as before.

The full rules, and the checks before a PR, are in
[desktop-contributing.md](desktop-contributing.md).

## How it connects, and what it never holds

| Need | How | On the member's machine |
|---|---|---|
| Who the member is | OIDC authorization code with PKCE, public client `studio-desktop`, loopback redirect (RFC 8252) | the member's Studio token, in the IDE backend's memory |
| Studio's APIs | the IDE backend proxies `studio-api/*` to `<studio>/cf/*` and attaches the token | nothing: the frontend never sees the token |
| Source code | `git` against `<studio>/cf/studio-git/v1/workspaces/{id}/sources/{name}`, a proxy that attaches the source host's token from credstore | a credential helper path in `.git/config`, no token |
| `git` credentials | `theia/studio/scripts/desktop-git-credentials.mjs` asks the IDE backend's token broker, over loopback, for a fresh Studio token | a per-run secret in the environment, worthless once the app exits |
| Where a project is open | each window beats every 30 s; the IDE backend renews a lease at `<studio>/cf/studio-session/v1/desktop-sessions` as this device, and ends it when the window closes (ADR-0027 §4) | a random device id in `settings.json` |

Nothing is written to disk but the member's choice of Studio
(`~/ConstructorStudio/settings.json`) and the clones
(`~/ConstructorStudio/workspaces/<workspace>`). `settings.json` also keeps
`deviceId`, a random UUID drawn on the first lease, so that a restarted app renews
the leases it had. It names the installation and nothing else. It is not a
credential: every lease call is authorized by the member's token, and a copied
id only makes two machines look like one in the portal's list.

One more, when the member opens an Orca agent's terminal: the IDE streams it
over the Orca runtime's WebSocket, which takes a paired device. A session is
paired when Orca starts in it; on the desktop the Orca app is already running,
and only its window can issue a pairing. So the first **Open** on an agent (or
**Orca: Pair with Orca on This Computer**) asks for the link Orca generates —
*Settings → Pair another Orca client → This computer → generate an access
link* — and keeps it in `~/ConstructorStudio/orca-pairing`, readable by the
member only. It is Orca's token for this machine's own runtime on
`127.0.0.1`, not a Studio secret; revoking it in Orca, or deleting the file,
undoes it.

## What a Studio deployment needs

**1. The `studio-desktop` Keycloak client.** The client is in both realm files
(`keycloak/realm-studio.json` for deployments,
`docker/keycloak/realm-studio.json` for Docker Compose). **A realm file is
imported only when the realm is created**, so an existing realm — any stand
that already runs — needs it added once:

- Keycloak admin console → realm **studio** → **Clients** → **Import client** →
  paste the `studio-desktop` entry from `keycloak/realm-studio.json` → **Save**.
- It is a public client with PKCE (S256) and one redirect,
  `http://127.0.0.1/*`. Keycloak ignores the port of a loopback redirect, so
  the app may listen on any free one.

Check a stand with:

```bash
curl -s "https://<studio>/auth/realms/studio/protocol/openid-connect/auth?client_id=studio-desktop&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback&scope=openid&code_challenge=x&code_challenge_method=S256" \
  | grep -o "kc-form-login\|Client not found"
```

`kc-form-login` means the client is there.

**2. `studio-desktop` as a first-party client** of the backend's
`oidc-authn-plugin` (`first_party_clients` in `studio-backend/config/*.yaml`),
so its tokens carry the portal's scopes. Already set in every profile.

**3. The `studio-git` gear** for opening a workspace. Without it, signing in and
listing workspaces work, and opening one says the Studio "cannot clone for a
desktop yet".

## Which Studios a build offers

A packaged build carries a list of Studios and starts on one of them. The list
is `theia/electron-app/environments.json`:

```json
[
  { "id": "dev",   "label": "Dev",   "studioUrl": "https://studio-dev.cfabric.org",  "issuer": "https://studio-dev.cfabric.org/auth/realms/studio" },
  { "id": "test",  "label": "Test",  "studioUrl": "https://studio-test.cfabric.org", "issuer": "https://studio-test.cfabric.org/auth/realms/studio" },
  { "id": "local", "label": "Local", "studioUrl": "http://127.0.0.1:8090",          "issuer": "http://127.0.0.1:8088/realms/studio" }
]
```

- `studioUrl` is the Studio's public address; the gateway is under `/cf`.
- `issuer` is the realm whose endpoints the app signs in against. It may be
  left out: the default is `<studioUrl>/auth/realms/studio`, which is where the
  Helm chart puts Keycloak.
- **Local** reaches the Compose Keycloak over plain HTTP on 8088. Its tokens
  still carry `iss=https://localhost:8443/realms/studio`, which is what the
  local backend trusts, so the app needs no trust in the dev certificate.

The member switches in the Studio view; **Other…** takes any address. Switching
signs out of the current Studio. The choice is kept in
`~/ConstructorStudio/settings.json` and wins over the build's default.

### Settings the app reads

A packaged app's entry point (`theia/electron-app/desktop-main.js`) sets these
from the build; a value already in the environment wins, which is how one
installed build is pointed somewhere else for a test.

| Variable | Meaning |
|---|---|
| `STUDIO_DESKTOP_ENVIRONMENTS` | the offered Studios, as the JSON above |
| `STUDIO_DESKTOP_DEFAULT` | the `id` to start on |
| `STUDIO_DESKTOP_URL` | **pins** one Studio and hides the choice; for a developer's `theia start` |
| `STUDIO_DESKTOP_ISSUER` | the pinned Studio's realm; default `<url>/realms/studio` |
| `STUDIO_DESKTOP_SETTINGS` | where the choice is kept; default `~/ConstructorStudio/settings.json` |
| `STUDIO_DESKTOP_WORKSPACES` | where opened workspaces are cloned; default `~/ConstructorStudio/workspaces` |
| `STUDIO_DESKTOP_BROWSER` | a command to open the sign-in page with, instead of the system browser |
| `STUDIO_DESKTOP_AUTO_SIGN_IN` | `1` starts the sign-in at launch |
| `GEARBOX_ENGINE` | the `gearbox` executable behind the gear catalogue; default the one the build ships (`resources/bin/`), else `gearbox` on `PATH` |

With none of the first three set, the IDE is an ordinary editor and the Studio
view does not open.

## Run it from a checkout

For working on the desktop code itself, against the local Compose stack:

```bash
cd theia
npm ci
npm --prefix drawio-editor run build
cd electron-app
npx theia download:plugins
npx theia rebuild:electron --cacheRoot ..
npx theia build --mode development
STUDIO_DESKTOP_URL=http://127.0.0.1:8090 \
STUDIO_DESKTOP_ISSUER=http://127.0.0.1:8088/realms/studio \
STUDIO_ACTOR_ID=desktop STUDIO_WORKSPACE_ID=desktop \
STUDIO_WORKSPACE_ROOT=$HOME/ConstructorStudio/workspace \
STUDIO_REPOSITORY_ROOT=$HOME/ConstructorStudio/workspace \
STUDIO_DATA_DIR=$HOME/ConstructorStudio/data \
npx theia start --plugins=local-dir:../plugins
```

The `STUDIO_ACTOR_ID` … `STUDIO_DATA_DIR` values are what the studio extension's
runtime config requires; a packaged app sets them itself.

`theia rebuild:electron` compiles the native modules (`node-pty`, `keytar`,
`drivelist`, `native-keymap`) for Electron, which on Windows needs the C++
build tools of Visual Studio.

## Debugging

Run it the way **Run it from a checkout** does, with Chromium's debugging port
open and development bundles, so stack traces point at the TypeScript:

```bash
npx theia build --mode development
STUDIO_DESKTOP_URL=... npx theia start --plugins=local-dir:../plugins --remote-debugging-port=9224
```

- **Frontend.** *Help → Toggle Developer Tools* in the app, or attach from
  Chrome: `chrome://inspect` → *Configure* → `localhost:9224`. A script can
  drive the same page over CDP: `GET http://127.0.0.1:9224/json/list`, take the
  `page` target, `Runtime.evaluate`.
- **Backend.** The Node backend logs to the terminal `theia start` runs in;
  every line of the desktop's own is prefixed `[studio-desktop]` (sign-in
  address, who signed in, each clone). Add `--log-level=debug` for Theia's own.
  To step through it, `--inspect=9229` on `theia start` and attach VS Code or
  `chrome://inspect`.
- **What the Studio view sees.** From the DevTools console, the same calls the
  view makes — the token is attached by the backend, never visible here:

  ```js
  await (await fetch('/studio-desktop/status')).json()               // state, user, current Studio
  await (await fetch('/studio-api/account-management/v1/me')).json() // subject_tenant_id
  await (await fetch('/studio-api/studio-user/v1/me/memberships')).json() // the organizations offered
  ```

  An empty `memberships` list is the "not a member of an organization yet"
  message, not a desktop bug: accept an invitation in the portal.
- **Sign-in.** `STUDIO_DESKTOP_BROWSER=<command>` opens the sign-in page with
  another browser (a clean profile, say); `STUDIO_DESKTOP_AUTO_SIGN_IN=1` starts
  it at launch. A local Keycloak on `https://localhost:8443` needs
  `NODE_EXTRA_CA_CERTS=docker/keycloak/certs/dev-ca.pem`.
- **Another Studio, same install.** Environment variables win over the build's
  preset, so an installed app can be started from a terminal against a local
  stack without rebuilding it.

## Build an installer

After `theia build` in `theia/electron-app`:

```bash
npm --prefix theia/electron-app run package -- --default dev --version 0.1.0
```

- The output is `theia/electron-app/dist/`: an NSIS installer
  (`Constructor-Studio-<version>-win-x64.exe`, a per-user install, no
  administrator rights) and a zip of the same app. The script also names dmg
  and AppImage targets for macOS and Linux; only Windows has been built so far.
- `--environments <file>` ships another list; `--studio-url <address>
  [--issuer <realm>]` ships exactly one Studio.
- `--gearbox <path>` ships that `gearbox` executable as `resources/bin/gearbox.exe`,
  the engine behind the gear catalogue, products and `.gdl`. Without it the
  build still packages, and its catalogue says no engine is installed; a
  developer's `theia start` needs `gearbox` on `PATH` or `GEARBOX_ENGINE`.
- The app is staged without `node_modules`: the Theia bundle in `lib/` is
  self-contained (its only external is `electron`), so the installer carries
  the bundle, `desktop-main.js`, the git credential helper, the built-in
  plugins and the CFS map schema. No asar — the bundle spawns executables
  (`rg.exe`, the `node-pty` agents, the helper) by paths relative to itself.

### In CI

`.github/workflows/desktop-windows.yml` builds and packages on `windows-2022`,
where the native modules compile, and uploads the installer and the zip as the
run's artifact. It builds the `gearbox` engine too, from source, at the
repository, revision and Rust that `theia/Dockerfile`'s `gearbox` stage pins for
the session image — one pin for both — and caches the build per revision. It runs when `theia/electron-app/**` or the workflow changes,
and on demand (**Actions → Desktop — Windows build → Run workflow**) with:

| Input | Default | Meaning |
|---|---|---|
| `default_environment` | `dev` | the Studio the build starts on |
| `studio_url`, `issuer` | empty | instead, ship exactly one Studio |
| `version` | `0.1.0` | the version the installer carries |

### The assistant extensions

Claude Code and Codex ship as the VS Code extensions product-ext drives. The
workflow reads the `fetch_vsix` pins from `theia/Dockerfile` and downloads each
one's `win32-x64` build from open-vsx. When the pinned version has no win32
build, it takes the newest win32 build instead, and the run warns about it.
Codex 26.5803.61601 was pinned while 26.5730.61309 shipped, so the desktop and
the session can run different Codex versions.

Codex is most of the installer. Its win32 VSIX is 364 MB and unpacks to 958 MB:

| Part | Unpacked | In the VSIX |
|---|---|---|
| `bin/windows-x86_64` (the CLI, sandbox, `rg`) | 428 MB | 153 MB |
| `bin/linux-x86_64` (only for *run Codex in WSL*) | 361 MB | 135 MB |
| `webview/` | 156 MB | 58 MB |

The workflow drops `bin/linux-*`, which leaves 598 MB unpacked. Codex uses those
binaries only when the member turns on its WSL setting, which is off by default.
Compressed with xz, the linux binaries come to 92 MB. The NSIS installer should
therefore shrink from 451 MB (0.3.0-beta.3) to roughly 360 MB. That figure is
an estimate until the next workflow run builds the installer.

**Proposed: fetch the assistants on first use instead of shipping them**
([design below](#lazy-assistants)), tracked in
[#480](https://github.com/constructorfabric/studio-web/issues/480).

<a id="lazy-assistants"></a>
#### Lazy assistants: the design

What changes: the installer carries a manifest instead of the two extensions.
The app fetches them into the member's profile when it first needs them. The
session image stays as it is: the Dockerfile keeps fetching the linux builds,
and nothing below runs in a session.

1. **The pin, written once.** The workflow resolves the version exactly as it
   does now (the Dockerfile pin, or the newest win32 build when the pin has
   none). It records `{ id, version, target, url, sha256 }` for each extension
   in `resources/assistants.json`. It takes the digest from open-vsx
   (`…/file/<name>.sha256`, which the API lists as `files.sha256`) and checks it
   against a download made during the build. The build then trusts only its own
   manifest, not open-vsx's answer at run time.
2. **Where they go.** `~/ConstructorStudio/plugins/<id>-<version>/`, unpacked.
   `desktop-main.js` adds that folder to Theia's plugin sources next to
   `resources/plugins` (`THEIA_PLUGINS=local-dir:…`), so a copy already fetched
   loads at start like a built-in plugin. The folder holds code from open-vsx,
   not a secret, so rule 2 of desktop-contributing.md holds. It still needs its
   line in this page.
3. **When they are fetched.** A desktop-only backend contribution
   (`studio/src/node/desktop-assistants.ts`) mounts only when a Studio is
   configured, like `DesktopStudioContribution`. It starts in the background
   after the window is up and fetches whichever extension from the manifest is
   missing. It streams the download to a temporary file, checks the SHA-256
   against the manifest, unpacks the file, and moves the folder into place in
   one rename. It then deploys the extension into the running app with
   `PluginServer.install('local-dir:<folder>')` (`@theia/plugin-ext`), so no
   restart is needed. Until the extension is in place, the rail's assistant
   says "Codex is downloading (37 %)" rather than "… is not available here".
   A failed download or a digest mismatch leaves nothing behind. The message
   then says what failed and offers to try again.
4. **Updates.** A new app version can carry a new manifest. On start, the
   contribution fetches any pinned version that is missing. It deletes other
   versions of the same extension only after the new one deploys.
5. **Offline and locked-down machines.** Where open-vsx is out of reach, the
   member can put the VSIX next to the installer. The contribution looks there
   first and applies the same digest check.

What it saves: the installer drops to an estimated 140–160 MB (the Theia
bundle, Electron, `gearbox.exe`). This is not measured, since no build has been
made that way. The member then downloads the two VSIXs once: 96 MB for Claude
Code and 364 MB for Codex, whose download still includes the linux binaries. What it costs: a first-use wait, a new failure mode that needs its
own messages (rule 5), and one more place where a file is written.

## Updates

An installed app updates itself from the rolling `desktop-updates` release,
which every `desktop-v*` release refreshes
(`theia/electron-app/desktop-updater.js`). It checks on start and every six
hours, downloads what it finds, and asks once it has: restart now, later (it
installs on quit), or read what changed. Nothing is forced.

**Help → Check for Updates…** checks now and says what it found — the latest
already, an update downloading, one downloaded (and asks again), or why the
check failed. Stable or beta is the Studio view's *Get beta versions of the
app*. A checkout's `theia start` and an unpacked zip are not updated in place,
and say so.

The menu item exists only in the desktop app: it is a `frontendElectron`
module talking to an `electronMain` one over Theia's Electron IPC
(`theia/studio/src/electron-browser`, `src/electron-main`), and a session's
`browser-app` loads neither.

## Known limits

- The installer is not code-signed, so Windows SmartScreen asks before the
  first run.
- The workspace a member opens is cloned, not synchronised: the Studio sees
  what they push, and nothing before it.
- Desktop sessions are not yet visible in the portal, and the portal cannot yet
  send a desktop a command (ADR-0027 phases 3–5).
- Up to 0.3.0-beta.3, opening Codex on the desktop showed "Codex couldn't load
  its resources." Its webview's resources did load. The Codex CLI behind it
  exited at start because its `CODEX_HOME` did not exist. Two things caused
  that. The credential home named the directory without creating it. On
  Windows, linking the anonymous home to the member's home also failed: a
  symlink needs a privilege, so the home was emptied and then removed. The
  first cause also hit browser sessions whose home had no `.codex` yet. The
  Codex output channel shows the CLI's error. Fixed by
  `ensureAssistantHomes` and a junction on Windows
  (`theia/product-ext/src/node/viewer-credentials-env.js`). An installed
  beta.3 has no workaround: every start draws a new anonymous home and removes
  it again. In a browser session, signing in to Codex from the product's
  assistant sign-in creates the directory, and reloading the page then works.
- Codex cannot run in WSL on the desktop: the installer leaves out its linux
  binaries ([The assistant extensions](#the-assistant-extensions)).
- The desktop's Codex can be older than the session's. The Dockerfile pin has
  no win32 build, so the installer ships the newest one that has.
