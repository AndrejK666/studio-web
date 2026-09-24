# The desktop Studio

The desktop Studio is the IDE running on a member's own machine, as an
installed application, and connected to a Studio deployment — dev, test, a
local stack, or any other. It is the same Theia application a session runs in
a container (`theia/electron-app` has the extensions of `theia/browser-app`),
with one difference that decides everything else: the backend did not start
it, so nothing on the member's machine may hold a secret of the
organization's. [ADR-0027](adr/0027-a-desktop-session-keeps-the-secrets-on-the-server.md)
is the decision; this page is how to build, configure and run it.

What a member does:

1. Starts **Constructor Studio**, picks the Studio in the **Constructor
   Studio** view (Dev, Test, Local, or an address), and clicks **Sign in with
   Constructor ID**.
2. Signs in on the realm's own page, in the system browser. The app waits on a
   loopback port and takes the answer.
3. Sees their organizations and workspaces, and clicks one to open it: its
   sources are cloned through the Studio and the folder opens in the IDE.

## How it connects, and what it never holds

| Need | How | On the member's machine |
|---|---|---|
| Who the member is | OIDC authorization code with PKCE, public client `studio-desktop`, loopback redirect (RFC 8252) | the member's Studio token, in the IDE backend's memory |
| Studio's APIs | the IDE backend proxies `studio-api/*` to `<studio>/cf/*` and attaches the token | nothing: the frontend never sees the token |
| Source code | `git` against `<studio>/cf/studio-git/v1/workspaces/{id}/sources/{name}`, a proxy that attaches the source host's token from credstore | a credential helper path in `.git/config`, no token |
| `git` credentials | `theia/studio/scripts/desktop-git-credentials.mjs` asks the IDE backend's token broker, over loopback, for a fresh Studio token | a per-run secret in the environment, worthless once the app exits |

Nothing is written to disk but the member's choice of Studio
(`~/ConstructorStudio/settings.json`) and the clones
(`~/ConstructorStudio/workspaces/<workspace>`).

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
- The app is staged without `node_modules`: the Theia bundle in `lib/` is
  self-contained (its only external is `electron`), so the installer carries
  the bundle, `desktop-main.js`, the git credential helper, the built-in
  plugins and the CFS map schema. No asar — the bundle spawns executables
  (`rg.exe`, the `node-pty` agents, the helper) by paths relative to itself.

### In CI

`.github/workflows/desktop-windows.yml` builds and packages on `windows-2022`,
where the native modules compile, and uploads the installer and the zip as the
run's artifact. It runs when `theia/electron-app/**` or the workflow changes,
and on demand (**Actions → Desktop — Windows build → Run workflow**) with:

| Input | Default | Meaning |
|---|---|---|
| `default_environment` | `dev` | the Studio the build starts on |
| `studio_url`, `issuer` | empty | instead, ship exactly one Studio |
| `version` | `0.1.0` | the version the installer carries |

## Known limits

- The installer is not code-signed, so Windows SmartScreen asks before the
  first run.
- There is no automatic update yet.
- The workspace a member opens is cloned, not synchronised: the Studio sees
  what they push, and nothing before it.
- Desktop sessions are not yet visible in the portal, and the portal cannot yet
  send a desktop a command (ADR-0027 phases 3–5).
