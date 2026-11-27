# GitLab sign-in through Keycloak

People can sign in to Studio with a GitLab account, on gitlab.com or on a
self-hosted GitLab. The `studio` realm brokers GitLab under the alias `gitlab`,
shown as **GitLab** on Keycloak's sign-in page and on the portal's sign-in
screen. As with GitHub, Studio keeps consuming the same Keycloak issuer and
receives no GitLab token.

Unlike GitHub, nothing restricts who may sign in: any GitLab account of the
configured GitLab gets a realm identity, and no Studio access (ADR-0011).

## What a sign-in does

| Step | Behaviour |
| --- | --- |
| Protocol | Generic OIDC broker against the GitLab's own discovery document (`<base>/.well-known/openid-configuration`), authorization code with PKCE S256, scopes `openid profile email read_user`, client authentication `client_secret_post`. ID tokens are checked against GitLab's JWKS. |
| Why not Keycloak's `gitlab` provider type | The stock provider has gitlab.com's endpoints built in, so it cannot broker a self-hosted GitLab. One generic OIDC broker serves both. |
| Base URL | GitLab's OIDC issuer is its external URL (`https://gitlab.com`, `https://gitlab.example.com`, or with a relative root `https://example.com/gitlab`). The script refuses a discovery document whose issuer differs from the configured base URL. |
| First sign-in, new address | Keycloak's stock `first broker login` creates the realm user. |
| First sign-in, an address a user already has | The same flow links the GitLab account to that user once they confirm by signing in as themselves. Keycloak never links on the address alone (`keycloak/tests/account-takeover.test.mjs`); this holds for every broker in the realm. |
| Email trust | `trustEmail` is on, and Keycloak's OIDC broker then copies GitLab's `email_verified` claim to the user. GitLab sets it only for a confirmed address, so an unconfirmed one stays unverified in the realm and cannot accept an invitation. |
| Tenant claim | Studio refuses a token without `tenant_id`, so the broker has one mapper, `gitlab-tenant-id`, which gives a new user the sandbox tenant `00000000-0000-0000-0000-000000000002` exactly as `github-tenant-id` and `constructor-tenant-id` do (`keycloak.gitlabIdp.tenantId`, `GITLAB_IDP_TENANT_ID`). See the ADR-0011 amendment about why the mapper stays. |
| Organizations | None. No mapper sets a role or a group, and the tenant above is not an organization. The person lands in the no-access state until an invitation or an administrator adds them. |
| Alias | The brokered link confirms the alias `gitlab:<username>` through `FederatedIdentityReader`, as GitHub's confirms `github:<login>` (ADR-0015). Keycloak names the linked account by the ID token's `preferred_username`, which is the GitLab username, and keeps the `sub`, which is GitLab's numeric user id. |
| Photo | A profile with no photo gets the GitLab account's picture (`studio-backend/src/user_profile/gitlab_avatar.rs`): `GET <gitlab_url>/api/v4/users/<numeric id>`, or by username without an id. `gitlab_url` is `studio-user.gitlab_url`, set from the same base URL below, so a self-hosted GitLab's photos are found. A private profile or no answer within 4 s leaves the profile as it is. |

The broker takes the discovery document's `end_session_endpoint` as its logout
URL when there is one. GitLab is not known to publish one, in which case
signing out of Studio leaves the browser signed in to GitLab. Not yet checked
on a stand.

## The GitLab OAuth application

Create one OAuth application per environment. On gitlab.com, an application
owned by a group (**Group > Settings > Applications**) survives a person
leaving; a user-owned one (**User settings > Applications**) works too. On a
self-hosted GitLab an administrator can create an instance-wide one under
**Admin area > Applications**.

| Field | Value |
| --- | --- |
| Name | `Constructor Studio Dev` / `Constructor Studio Test` |
| Redirect URI | the environment's row below |
| Confidential | on |
| Scopes | `openid`, `profile`, `email`, `read_user`, nothing else |

Every scope the broker asks for must be enabled on the application, or GitLab
answers `invalid_scope`. `read_user` is read access to the person's own
profile; no repository or API scope is requested.

| Environment | Redirect URI |
| --- | --- |
| dev | `https://studio-dev.cfabric.org/auth/realms/studio/broker/gitlab/endpoint` |
| test | `https://studio-test.cfabric.org/auth/realms/studio/broker/gitlab/endpoint` |
| local stand | `https://localhost:8443/realms/studio/broker/gitlab/endpoint` |

GitLab shows the **Application ID** (the client id) and the **Secret** after
saving. The secret goes to the vault Secret below, the id to the values.

## Configuration

One script writes the broker: `deploy/helm/studio-web/files/keycloak/gitlab-idp.sh`.
It runs in the Keycloak image (it needs `kcadm.sh`), is idempotent, and does
one of three things:

| Inputs | Result |
| --- | --- |
| Base URL, client id and client secret present | Discovery is read, then the broker is created or updated in place and enabled. |
| Any of them missing | An existing broker is switched off (`enabled: false`); none is created. |
| `GITLAB_IDP_REMOVE=1` | The broker and its links are deleted. Realm users stay. |

The alias is fixed at `gitlab`: `studio-user` recognizes a GitLab sign-in by
it, and the sign-in button's `kc_idp_hint` names it.

### Kubernetes (Helm)

```yaml
keycloak:
  gitlabIdp:
    enabled: true
    baseUrl: https://gitlab.com     # or the self-hosted GitLab's external URL
    clientId: <Application ID>
```

`enabled` renders a ConfigMap with the script and a `post-install,post-upgrade`
Job, `<release>-keycloak-gitlab-idp`, which signs in to the master realm with
`studio-web-keycloak-admin`, waits for Keycloak (`waitSeconds`, 600 by default)
and runs the script. `values-dev.example.yaml` and `values-test.example.yaml`
carry the block, switched off.

The same condition (`keycloak.enabled`, `gitlabIdp.enabled`, `baseUrl` and
`clientId`) sets `STUDIO_GITLAB_SIGN_IN` on the portal, which shows the
**GitLab** button. `gitlabIdp.enabled` with `baseUrl` also sets
`STUDIO_GITLAB_URL` on the backend, read by `config/k8s.yaml` as
`studio-user.gitlab_url`.

### Kubernetes credentials

The client secret never enters the values or the Job's environment. It is the
key `studio_gitlab-client-secret` of the files-plaintext vault Secret
`studio-web-keycloak-vault`, the Secret the GitHub broker reads. The broker
stores `${vault.gitlab-client-secret}`, and Keycloak resolves it at sign-in.
The Job mounts only that one key, to see whether it exists. The client id goes
in the values because Keycloak does not resolve a vault reference in an OIDC
broker's `clientId`.

A missing vault key switches the broker off without the chart knowing, while
the portal still shows the button, which then ends on a Keycloak error page.
Add the key before enabling.

`kubectl create secret ... | kubectl apply` replaces the whole Secret, so pass
every key it already holds:

```powershell
$gitlabSecretSecure = Read-Host "GitLab OAuth application secret" -AsSecureString
$gitlabSecret = [Net.NetworkCredential]::new("", $gitlabSecretSecure).Password
# ...plus the GitHub/Constructor/Google/Microsoft keys the Secret already holds:
kubectl -n studio-dev create secret generic studio-web-keycloak-vault `
  --from-literal=studio_github-client-id="$githubClientId" `
  --from-literal=studio_github-client-secret="$githubClientSecret" `
  --from-literal=studio_constructor-client-secret="$constructorSecret" `
  --from-literal=studio_gitlab-client-secret="$gitlabSecret" `
  --dry-run=client -o yaml | kubectl apply -f -
Remove-Variable gitlabSecret, gitlabSecretSecure
```

Repeat for `studio-test` with that environment's own application.

### Rollout

Per environment:

1. Create the GitLab OAuth application above with the environment's redirect
   URI.
2. Check that Keycloak's pods reach the GitLab: discovery, `token`, `jwks` and
   `userinfo` are called from inside the cluster, not from the browser.
   gitlab.com needs egress to it (cluster-specific-bundles, as for GitHub);
   a self-hosted GitLab must be reachable at the same base URL the browser
   uses. The Job fails the release while it cannot reach discovery.
3. Add `studio_gitlab-client-secret` to `studio-web-keycloak-vault`.
4. Set `keycloak.gitlabIdp.enabled: true` with `baseUrl` and `clientId`, then
   deploy. The Job's log says `created` or `updated`.
5. Sign in with a GitLab account that has no Studio membership: Studio shows
   the no-access state, the profile carries the GitLab photo and the alias
   `gitlab:<username>`. Invite that address and sign in again.

To switch it off, blank `clientId` and deploy: the Job switches the broker off
and the button disappears. `enabled: false` stops the Job and hides the button
but leaves the broker as the last run wrote it; remove it with a one-off run of
the script with `GITLAB_IDP_REMOVE=1`.

### The compose stand

`docker compose up` runs the one-shot service `keycloak-gitlab-idp` after
Keycloak is healthy. Without credentials it creates nothing.

| `.env` | Effect |
| --- | --- |
| nothing | no broker, no button |
| `STUDIO_GITLAB_IDP_CLIENT_ID`, `STUDIO_GITLAB_IDP_CLIENT_SECRET` | gitlab.com, from an application whose redirect URI is `https://localhost:8443/realms/studio/broker/gitlab/endpoint` |
| plus `STUDIO_GITLAB_IDP_BASE_URL` | a self-hosted GitLab; Keycloak's container must reach it at that address |
| the secret removed again | broker switched off on the next run, button gone |

The portal (compose service `frontend`) shows the button when
`STUDIO_GITLAB_IDP_CLIENT_SECRET` is set; set the client id with it. The
backend gets the base URL as `STUDIO_GITLAB_URL` (`config/docker.yaml`,
`studio-user.gitlab_url`). The Vite dev server takes
`STUDIO_GITLAB_SIGN_IN=true`.

Run it again after a realm change with
`docker compose run --rm keycloak-gitlab-idp`, and remove the broker with
`docker compose run --rm -e GITLAB_IDP_REMOVE=1 keycloak-gitlab-idp`.
