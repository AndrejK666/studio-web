# ADR-0015: A brokered login is a proof of control, and Keycloak only tells you if you ask

Status: **proposed** · Date: 2026-09-10 · Implements ADR-0012 follow-up 2 · Extends ADR-0014

## Context

ADR-0012 made a provider's confirmation of control the only thing that binds an
external identity to a person, and named exactly one channel for it: a personal
connector connection whose credential passed `ConnectorDriver::test()`. It listed
Keycloak's `federated_identities` as "a second proof channel … not wired here".

That channel is the better one. A person who signed in through GitHub has already
completed GitHub's own authorization flow, and GitHub named the account it
resolved to — the same class of proof as a personal access token, obtained
without the person doing anything beyond signing in. Under the connector-only
rule, somebody who logs in with GitHub every day and has never created a
connection has no confirmed identity at all, so their commits stay unattributed.

Two things were in the way, and the first was not what the code believed.

**Keycloak does not ship federated identities on a user representation.**
`identity_directory` deserialized a `federatedIdentities` array off
`KeycloakUser` and surfaced the first entry as `DirectoryIdentity.identity_provider`.
Verified against a Keycloak 26.7 realm: neither
`GET /admin/realms/{realm}/users?briefRepresentation=false` nor
`GET /admin/realms/{realm}/users/{id}` carries that key at all. The field was
therefore **always `None`** — a directory column that has never once been
populated — and the deserialization was dead code rather than a partial read.
The data lives only behind the dedicated
`GET /admin/realms/{realm}/users/{id}/federated-identity`, which returns
`[{identityProvider, userId, userName}]`. One request per user, and no bulk form.

**Nothing owned the read.** `studio-user` owns aliases but has no Keycloak
credential; `identity_directory` holds the credential but owns no attribution.

## Decision

### 1. A brokered login confirms an alias, through a narrow published read

`identity_directory` publishes `FederatedIdentityReader` on the ClientHub:

```text
federated_accounts(subject) -> Vec<FederatedAccount { provider, user_id, user_name }>
```

One subject at a time and read-only. The identity gear calls it about the person
signed in right now; a bulk or arbitrary-subject form would be an
account-enumeration surface and nothing needs one. `studio-user` attaches it in
its REST phase, the same way and for the same reason as the connector catalogue —
the directory is a separate gear, and every gear's `init` has run by then.

### 2. The ceremony has two channels, and needs either

`/me/aliases/confirm` (`confirm_aliases`, formerly
`confirm_aliases_from_connections`) now runs both channels and refuses only when
**neither** is available. Before, a deployment without a connector driver plugin
got a 400 even if every person in it had signed in through GitHub. An identity
confirmed through both channels is written once and reported as
`already_confirmed`.

### 3. Every login the person holds is asked about, not the current one

The walk is over the person's Keycloak `login` rows, not `ctx.subject_id()`. A
person who merged two accounts may have brokered a different provider onto each,
and both are proofs they own — which is the whole point of one person holding
several logins (ADR-0014). Non-Keycloak logins are skipped: only a realm subject
has brokered accounts to read.

### 4. The alias is keyed on the handle, not the provider's id

`FederatedAccount` carries both `userId` (stable) and `userName` (renameable),
and the alias records the **handle**. The handle is what the artefacts being
attributed carry: a commit names an author, not an account id, and
`connectors/graph_sync` matches contributor logins. Keying on the stable id would
be a more durable record of a fact nothing can look up.

The cost is explicit: a handle renamed at the provider leaves a row pointing at
this person under the old name, and the new name is confirmed on the next
ceremony. That is a re-confirmation rather than a silent break — the stale row
still names the right person, and only that person can displace it.

A broker reporting no handle at all is counted (`skipped_no_handle`) and not
attributed: it proves control of an account nothing else can name, so there is
nothing for an attribution to match.

### 5. The directory column is fixed, at one request per listed user

A unit test asserting the old reading — that the projection names the first
entry of `federatedIdentities` — is replaced rather than kept. It passed because
it fed the projection a shape Keycloak never sends; what it pinned was an
unreachable branch. What replaces it pins that the projection invents no
provider, and says why in the test itself, so the next reader does not restore
the guess.


`list()` now fills `identity_provider` from the endpoint that actually has it,
with a bounded concurrency window (`FEDERATION_LOOKUP_WINDOW = 8`) over the
listing's 200-user cap. A failure for one user leaves that label empty rather
than failing the listing: the label is informational, the directory is not.

### 6. The alias write moves off the service and onto the store

`attribute_alias_in(store, …)` is a free function; `IdentityService::attribute_alias`
delegates to it. The write policy needs the alias rows and nothing else about the
service, and saying so in the signature is what lets the ceremony be tested
without standing up Account Management or a connector catalogue.

## Options considered

- **Read federated identities inside `studio-user` with its own Keycloak client.**
  A second Keycloak admin credential in a second gear, for data the directory
  gear already owns the connection to. Rejected.
- **Fold the federated read into the directory's `list()` and have `studio-user`
  consume the listing.** The listing is platform-admin, tenant-unaware and
  200-capped; the ceremony needs one subject and runs as an ordinary person.
- **Attribute from the `identity_provider` label alone** (the field as it was
  intended). It names the broker, never the account, so it cannot attribute
  anything — and it was always empty besides.
- **Write the alias as a `login` row rather than an `alias`.** A brokered account
  is not a way into Studio: the way in is the Keycloak subject. Recording it as a
  `login` would claim that arriving as `github:90210` reaches this person
  directly, which is only true if that provider is separately wired as an
  authenticator.
- **Key the alias on `userId`.** See §4.

## Consequences

- (+) Signing in through a brokered provider is now enough to be credited with
  your own work. No token to create, no form to fill.
- (+) A deployment with no connector plugins gets working attribution.
- (+) The directory's provider column shows something for the first time.
- (−) The directory listing now makes up to one extra Keycloak request per listed
  user. Bounded at 8 concurrent, and the listing is admin-only and capped, but it
  is strictly more load than a column that returned nothing.
- (−) Attribution follows a renameable handle (§4).
- (−) `suggested` still has no source. Both channels write `confirmed`; the value
  exists, resolves and renders, and nothing produces it.

## Verified

On an isolated stand (own Postgres and own Keycloak 26.7 with the Studio realm,
the shared dev stack untouched): a realm user with a brokered
`github / 90210 / Octo-Probe` and **no connector connection** ran
`POST /me/aliases/confirm` and got
`confirmed: [{kind: "github", external_id: "octo-probe"}]`, normalized;
`GET /me/aliases` then reported it `confirmed` with `attributes: true`; a second
run reported `already_confirmed: 1` and rewrote nothing; and
`GET /studio-identity/v1/users` showed `identity_provider: "github"` for that
user and `null` for the two local ones.

## Follow-ups

1. **Provision at the authentication edge** so a person who never calls a
   `/me*` route still has a `user` row for this to attach to (ADR-0006
   follow-up 4, restated in ADR-0014).
2. **Run the ceremony on sign-in** rather than only when the person asks. The
   proof exists the moment they authenticate; today something has to call the
   endpoint.
3. **A source for `suggested`** — commit author addresses from the graph, e-mail
   equality across providers, login equality across providers.
4. **Sweep the orphaned `person:{login}` graph nodes** (ADR-0012 follow-up 4),
   now that a second channel will start producing `person:studio:{user_id}` keys
   for people who never created a connection.
