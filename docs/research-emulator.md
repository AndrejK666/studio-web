# Research emulator

Studio builds and runs a member's product on Constructor Research
([ADR-0049](adr/0049-constructor-research-runs-a-product-as-one-of-its-applications.md)).
Until a stand can reach a real Research (the restricted gateway is still being
agreed), the **Research emulator** stands in for it: `studio-backend
research-emulator`, the backend binary in another mode.

It answers exactly what Studio calls (ADR-0049 §6), on one origin as a stand
does:

| Path | What |
|---|---|
| `GET`, `POST /idp/connect/authorize` | the sign-in page: any email signs in; the first sign-in makes the member and a project of theirs |
| `POST /idp/connect/token` | code exchange (PKCE S256, client secret) and refresh |
| `POST /api/platform-account/access-keys` | a member's `rk-` access key, for the sign-in's token only |
| `/api/platform-account/v1/…` | session, projects, hardware, desks, images, applications, services |
| `MKCOL`, `PUT`, `GET`, `DELETE /api/platform-storage/desks/{d}/dav/project/…` | a desk's files, in memory |
| `GET /api/platform-keeper/image-builds/{i}/logs` | the build log, `text/event-stream`, open until the build ends |

Ids are 32 hex characters, refusals are `{"detail": {"msg", "error_code"}}`,
and an access key goes in `X-Research-AccessKey: Bearer rk-…`, as on a stand.

## What it does not do

Nothing is really built or run.

- **A build** reads its Dockerfile from the desk's files and writes a log of
  its instructions. It fails when the Dockerfile is missing, when it contains
  `research-emulator: fail`, or when the dashboard asks for the next build to
  fail.
- **A service** goes `starting` → `running` (or `failed`, when its image did
  not build). Its public link opens a page that says what would run: the
  image, ports, hardware and environment.
- **The desks' files** live in memory, so a restart empties them. Members,
  keys, projects, images and applications are kept in the state file when one
  is given.

## Signing in to Studio through it

The identity provider is also enough of an OpenID Connect provider for
Studio's Keycloak to broker it as the `constructor` login
([`keycloak/CONSTRUCTOR_SSO.md`](../keycloak/CONSTRUCTOR_SSO.md)), as Studio
brokers Constructor's real one:

| Path | What |
|---|---|
| `GET /idp/.well-known/openid-configuration` | discovery |
| `GET /idp/.well-known/openid-configuration/jwks` | the key ID tokens are signed with (ES256, made at start-up), at the real IdP's path |
| `POST /idp/connect/token` | also returns an `id_token` (`iss`, `aud`, `nonce`, `email`, `email_verified`, names) when the sign-in asked for `openid`, and takes the client secret by HTTP Basic too |
| `GET /idp/connect/userinfo` | the same claims, for the access token |
| `GET /idp/connect/endsession` | back to `post_logout_redirect_uri` when it is under a registered callback |

The sign-in page has a checkbox that signs in with `email_verified: false`.
There is no `preferred_username`, so Keycloak names the account by its email.

On the compose stand the emulator lists Keycloak's broker endpoint,
`https://localhost:8443/realms/studio/broker/constructor/endpoint`, among its
callbacks, and the `keycloak-constructor-idp` service points the broker at it.

## The gateway, checked

Any request the restricted gateway in front of a real stand would refuse
(another method on the WebDAV paths, a path Studio does not call) is answered
404 or 405 and listed in red on the dashboard. A change in what Studio calls
shows up there before it reaches a stand. The end-to-end test
(`connectors/research_emulator_tests.rs`) runs Studio's own client through a
sign-in, a build and a deploy, and fails on any such request.

## Dashboard

`<public URL>/_emulator`: members and their keys, desks, images with their
logs, applications and services with their links, recent requests, and two
buttons: make the next build fail, and reset everything.

## Running it

### docker-compose

`docker compose up` starts it as `research-emulator`, and the backend is
pointed at it unless `.env` names a real stand (`STUDIO_RESEARCH_*`).

- Studio: <http://localhost:8080>; connect Constructor Research among the connections.
- The emulator: <http://research.localhost:8095/_emulator>.

`research.localhost` is the emulator for both sides, the way one hostname is
on a real stand: the browser resolves any `*.localhost` to the loopback and
reaches the published port, and the backend container reaches it through a
network alias.

### Kubernetes (Helm)

```yaml
researchEmulator:
  enabled: true
```

The chart runs the backend image with `args: ["research-emulator"]`, sends
`/research-emulator` on the portal's hostname to it, and replaces
`backend.research` with the emulator's addresses. Studio-dev has it on
(`deploy/helm/values-dev.example.yaml`) until the gateway is up. Then set
`enabled: false`, and `backend.research` points at Constructor Research DEV
again.

### By hand

```
studio-backend research-emulator \
  --public-url http://research.localhost:8095 \
  --client-secret research-emulator \
  --redirect-uris http://localhost:8080/connections/oauth/callback
```

Every option has an environment variable (`RESEARCH_EMULATOR_*`, see
`--help`): `--listen`, `--public-url`, `--client-id`, `--client-secret`,
`--redirect-uris`, `--state-file`, `--desk-seconds`, `--build-seconds`,
`--start-seconds`.

Studio is then configured with:

| Setting | Value |
|---|---|
| `issuer` | `<public URL>/idp` |
| `api_url` | `<public URL>/api/platform-account/v1` |
| `client_id` | `constructor-studio` |
| `client_secret` | the emulator's `--client-secret` |
| `redirect_uri` | the portal's `/connections/oauth/callback` |

## A Research stand without a sign-in client

A stand where Studio has no `constructor-studio` client (the training stand,
`https://training.constructor.app`) is still reachable: set only `api_url`
(`https://<stand>/api/platform-account/v1`) and leave `issuer` and
`client_id` empty. Research is then offered key-only: a member logs in to
Research with a login and password, makes an access key there and pastes the
`rk-…` key into **Add connection**. In Helm: `backend.research.apiUrl` set,
`backend.research.issuer`/`clientId` empty, `researchEmulator.enabled=false`.

## A local stand against Research DEV

A machine on the VPN reaches Research DEV (`https://dev-constructor.dev`), and
a local backend can be pointed at it through `.env`:

| Variable | Value |
|---|---|
| `STUDIO_RESEARCH_ISSUER` | `https://dev-constructor.dev/idp` |
| `STUDIO_RESEARCH_API_URL` | `https://dev-constructor.dev/api/platform-account/v1` |
| `STUDIO_RESEARCH_CLIENT_ID` | `constructor-studio` |
| `STUDIO_RESEARCH_CLIENT_SECRET` | `research_client_secret` of the `studio-web-app` Secret (namespace `studio-dev`) |

The sign-in does not come back to a local portal, though. The identity
provider's client `constructor-studio` knows only Studio-dev's callbacks
(checked 2026-11-17): `https://studio-dev.cfabric.org/connections/oauth/callback`
is accepted, and `http://localhost:…/connections/oauth/callback` is answered
`invalid_request` before any sign-in page. Until Research registers a local
callback, a member signing in from a local portal has to start the sign-in
with Studio-dev's callback (add it to `STUDIO_RESEARCH_REDIRECT_URI` and send
it as `redirect_uri` to `POST /studio-connector/v1/oauth/start`) and carry the
`code` and `state` the identity provider sends there to the local portal's
`/connections/oauth/callback`. The exchange uses the callback the sign-in
started with, so the code is accepted.
