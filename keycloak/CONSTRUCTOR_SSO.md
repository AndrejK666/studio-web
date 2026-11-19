# Constructor IdP sign-in through Keycloak

People can sign in to Studio with their Constructor IdP account: the identity
provider behind Constructor Research (OIDC issuer
`https://dev-constructor.dev/idp` on DEV, client `constructor-studio`). Studio
already uses that IdP for the Research *connection* (ADR-0049); this adds it as
a *login*. The `studio` realm brokers it under the alias `constructor`, shown as
**Constructor** on Keycloak's sign-in page. As with GitHub, Studio keeps
consuming the same Keycloak issuer and receives no Constructor token.

## What a sign-in does

| Step | Behaviour |
| --- | --- |
| Protocol | Generic OIDC broker, authorization code with PKCE S256, scopes `openid email profile`, client authentication `client_secret_post`. |
| Endpoints | Read from the issuer's discovery document (`<issuer>/.well-known/openid-configuration`) by Keycloak's own importer. ID tokens are checked against the IdP's JWKS. |
| First sign-in, new address | Keycloak's stock `first broker login` creates the realm user, as it does for GitHub. |
| First sign-in, an address a user already has | The same flow asks that user to confirm the link by signing in as themselves first. Keycloak never links on the address alone (`keycloak/tests/account-takeover.test.mjs`). |
| Email trust | `trustEmail` is on, and Keycloak's OIDC broker then copies the IdP's `email_verified` claim to the user. An address the IdP does not vouch for stays unverified in the realm. Only when the ID token carries no `email_verified` at all does Keycloak fall back to "verified". |
| Organizations | None. Signing in proves who the person is and grants nothing (ADR-0011): no mapper sets a tenant, role or group. They land in the no-access state until an invitation or an administrator adds them. |
| Invitations | Accepted only for an address the realm holds as verified (`studio-user` reads it from the directory), so the IdP's `email_verified` decides whether a Constructor sign-in can take an invitation. |
| Alias | The brokered link confirms an alias `constructor:<handle>` through the same `FederatedIdentityReader` the other brokers use (ADR-0015). Keycloak names the linked account by the IdP's `preferred_username`, and by the email when there is none. |

Signing out of Studio also signs the browser out at the IdP: the broker has
the IdP's `end_session_endpoint` as its logout URL, so Keycloak sends the
browser there and back to `.../broker/constructor/endpoint/logout_response`.

## Configuration

One script writes the broker: `deploy/helm/studio-web/files/keycloak/constructor-idp.sh`.
It runs in the Keycloak image (it needs `kcadm.sh`), is idempotent, and does
one of three things:

| Inputs | Result |
| --- | --- |
| Issuer, client id and client secret present | Discovery is read, then the broker is created or updated in place and enabled. |
| Any of them missing | An existing broker is switched off (`enabled: false`); none is created. |
| `CONSTRUCTOR_IDP_REMOVE=1` | The broker and its links are deleted. Realm users stay. |

Nothing in code names a Constructor host: the issuer comes from the compose
`.env` or the Helm values.

### Kubernetes (Helm)

```yaml
keycloak:
  constructorIdp:
    enabled: true
    issuer: https://dev-constructor.dev/idp
    clientId: constructor-studio
```

`enabled` renders a ConfigMap with the script and a `post-install,post-upgrade`
Job, `<release>-keycloak-constructor-idp`, which signs in to the master realm
with `studio-web-keycloak-admin`, waits for Keycloak (`waitSeconds`, 600 by
default) and runs the script. `values-dev.example.yaml` and
`values-test.example.yaml` carry the block, switched off.

The client secret never enters the values or the Job's environment. It is the
key `studio_constructor-client-secret` of the files-plaintext vault Secret
`studio-web-keycloak-vault`, the same Secret the GitHub broker reads. The broker
stores `${vault.constructor-client-secret}`, and Keycloak resolves it at
sign-in. The Job mounts only that one key, to see whether it exists. The client
id goes in the values because Keycloak does not resolve a vault reference in an
OIDC broker's `clientId`.

`kubectl create secret ... | kubectl apply` replaces the whole Secret, so pass
every key it already holds:

```powershell
$constructorSecretSecure = Read-Host "constructor-studio client secret" -AsSecureString
$constructorSecret = [Net.NetworkCredential]::new("", $constructorSecretSecure).Password
# ...plus the GitHub/Google/Microsoft keys the Secret already holds:
kubectl -n studio-dev create secret generic studio-web-keycloak-vault `
  --from-literal=studio_github-client-id="$githubClientId" `
  --from-literal=studio_github-client-secret="$githubClientSecret" `
  --from-literal=studio_constructor-client-secret="$constructorSecret" `
  --dry-run=client -o yaml | kubectl apply -f -
Remove-Variable constructorSecret, constructorSecretSecure
```

Rollout, per environment:

1. The IdP team adds the redirect URIs below to the client.
2. Check that Keycloak's pods reach the issuer: discovery, `token`, `jwks`
   and `userinfo` are called from inside the cluster, not from the browser.
   Studio-dev cannot reach Research DEV yet (that is why the Research emulator
   stands in there), and the Job fails the release while it cannot.
3. Add `studio_constructor-client-secret` to `studio-web-keycloak-vault`.
4. Set `keycloak.constructorIdp.enabled: true` with the issuer and client id,
   then deploy. The Job's log says `created` or `updated`.
5. Sign in with a Constructor account that has no Studio membership: Studio
   shows the no-access state. Invite that address and sign in again.

To switch it off, blank `issuer` and deploy: the Job switches the broker off.
`enabled: false` stops the Job but leaves the broker as the last run wrote it.

### The compose stand

`docker compose up` runs the one-shot service `keycloak-constructor-idp`
after Keycloak and the Research emulator are healthy. By default it brokers
the emulator's IdP (`docs/research-emulator.md`): issuer
`http://research.localhost:8095/idp`, client `constructor-studio`, the
emulator's secret. The emulator lists the broker's endpoint among its
callbacks (`RESEARCH_EMULATOR_REDIRECT_URIS`):
`https://localhost:8443/realms/studio/broker/constructor/endpoint`. On the
emulator's sign-in page any email signs in; a checkbox signs in with
`email_verified: false`.

| `.env` | Effect |
| --- | --- |
| nothing | the emulator's IdP |
| `STUDIO_CONSTRUCTOR_IDP_ISSUER=` (empty) | broker switched off |
| `STUDIO_CONSTRUCTOR_IDP_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` | another IdP, which must list the local endpoint above |

Run it again after a realm change with
`docker compose run --rm keycloak-constructor-idp`, and remove the broker with
`docker compose run --rm -e CONSTRUCTOR_IDP_REMOVE=1 keycloak-constructor-idp`.

## Redirect URIs for the IdP team

Keycloak's broker endpoint is
`https://<host>/auth/realms/studio/broker/constructor/endpoint`. Add these to
client `constructor-studio`, beside its existing
`/connections/oauth/callback` URIs, or to a new client:

| Environment | Redirect URI | Post-logout redirect URI |
| --- | --- | --- |
| dev | `https://studio-dev.cfabric.org/auth/realms/studio/broker/constructor/endpoint` | `https://studio-dev.cfabric.org/auth/realms/studio/broker/constructor/endpoint/logout_response` |
| test | `https://studio-test.cfabric.org/auth/realms/studio/broker/constructor/endpoint` | `https://studio-test.cfabric.org/auth/realms/studio/broker/constructor/endpoint/logout_response` |

A new client instead of `constructor-studio` changes only `clientId` in the
values and the vault key's value.

### Message to the IdP team (draft)

> Hi! Constructor Studio would like people to sign in with their Constructor
> accounts. Studio's Keycloak brokers your IdP as a standard OIDC provider:
> authorization code with PKCE S256, scopes `openid email profile`, client
> secret sent in the body.
>
> Could you add the following to client `constructor-studio` on DEV, or create
> a separate client for this if you prefer:
>
> - Redirect URIs:
>   - `https://studio-dev.cfabric.org/auth/realms/studio/broker/constructor/endpoint`
>   - `https://studio-test.cfabric.org/auth/realms/studio/broker/constructor/endpoint`
> - Post-logout redirect URIs (so that signing out of Studio also ends the
>   IdP session):
>   - `https://studio-dev.cfabric.org/auth/realms/studio/broker/constructor/endpoint/logout_response`
>   - `https://studio-test.cfabric.org/auth/realms/studio/broker/constructor/endpoint/logout_response`
> - Allowed scopes: `openid`, `email`, `profile`. Studio's Research connection
>   already asks this client for `openid profile user platform`; sign-in adds
>   `email`.
>
> Two questions:
>
> 1. Does the ID token carry `email` and `email_verified`, or only userinfo?
>    We trust the address only when `email_verified` is true in the ID token.
> 2. What is `preferred_username` for a typical account: the email, or a
>    separate login?
>
> Our side does not need the secret to change. If you create a new client,
> please send its id, and the secret through the usual secure channel.

## Proposal, not built: a Constructor sign-in also connects Research

Today a person who signs in with Constructor still connects Constructor
Research separately, under Profile > My connections, and goes through the same
IdP a second time. Keycloak can keep the IdP's tokens from a brokered sign-in
(`storeToken: true`), and a client holding the `broker:read-token` role can
read them back from
`GET /realms/studio/broker/constructor/token`. Studio's backend could then,
right after sign-in, create or refresh the person's Research connection from
that token, with no second sign-in.

What it would take:

- `storeToken: true` on the broker, plus `read-token` granted to the client
  that fetches it. That could be the portal on the person's behalf, or the
  backend through a token exchange.
- Scopes `openid email profile user platform` on the broker, the union of
  what sign-in and Research each need, so that one consent covers both.
- A connector path that accepts an access token and refresh token it did not
  obtain itself, then mints the Research `rk-` key as the OAuth callback does.

Risks:

- **Token lifetime.** Keycloak stores the tokens of the last sign-in. A
  connection made from them works while the refresh token does, and Keycloak
  does not refresh brokered tokens itself. Whoever reads them owns the
  refresh, and two refreshers (Keycloak's stored copy and the connection's
  copy) may race for a rotating refresh token. The connection would need its
  own refresh token, so it would have to be minted rather than shared.
- **Scopes.** The sign-in would ask for Research's `user platform` scopes
  even for people who never use Research. That widens what a stolen
  Keycloak-side token can do, and it shows Research permissions on the consent
  screen at Studio sign-in.
- **Storage.** Stored IdP tokens live in Keycloak's database in a form a
  realm administrator can read. Today Keycloak holds no Research credential at
  all. That adds a second store for the same secret, next to credstore,
  without credstore's encryption at rest.
- **ADR-0015's trust model.** ADR-0015 accepts a brokered login as proof of
  control over an *alias*: a statement about who the person is. Turning the
  same event into a *credential* that acts in another system is a different
  claim. The two would then share a failure: whoever can make Keycloak link
  an account (a mistaken link, an administrator's edit) would also get a
  working Research connection under the person's name. A connection made
  this way should be marked as such, re-confirmable by the person, and
  refused for links Keycloak made through an administrator rather than
  through a sign-in.

Recommended order if it is built: the connector path first, behind an explicit
"connect with the account you signed in with" button rather than at every
sign-in. Then `storeToken` on the broker. Automatic connection last, after the
refresh ownership question is settled.
