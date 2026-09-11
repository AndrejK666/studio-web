# ADR-0017: We own the settings gear until the platform can be told who a caller is

Status: **proposed** · Date: 2026-09-11 · Completes ADR-0014's premise

## Context

ADR-0006 gave Studio a canonical person; ADR-0014 made it reachable from any
gear. The reason all of that exists — stated in the first sentence of the work —
was that a person's settings should be theirs however they signed in.

They are not. The platform's `simple-user-settings` gear files a row under
`(ctx.subject_id(), ctx.subject_tenant_id())`: the identity that signed in, in
the organization it signed into. It is linked into this assembly, and the
prototype portal already stores theme and language in it. So the one piece of
the product that a person would actually notice is the one still keyed on the
login.

For a product where each human has one login and one organization, subject and
human are the same thing and the gear is right. Studio is not that product:

- a person reaches one account through an e-mail login and a brokered GitHub
  login (ADR-0015 now confirms the second automatically);
- two accounts that turn out to be one human get merged (ADR-0006);
- a person belongs to several organizations (ADR-0011, ADR-0016).

Under that key a preference forks the moment somebody signs in the other way or
switches organization. Nothing errors and nothing is logged — the row is simply
filed under a key the next request does not produce, and the person's theme is
gone. It is the quietest failure in the subsystem.

The gear has no extension point: `ctx.subject_id()` is read in three places and
feeds both the storage key and the authorization owner.

## Options considered

**A. Configure it.** There is nothing to configure.

**B. Fix it upstream and consume the fix.** Correct, and the fix is written:
`constructorfabric/gears-rust#4785` adds a `SettingsOwnerResolver` the
deployment publishes on the ClientHub, defaulting to today's behaviour so it is
additive for every other consumer.

Consuming it *now* is what fails. Inside gears-rust the gear depends on the
toolkit by **path**, and `[patch]` does not redirect a path dependency inside a
git source — so taking these two crates from a different fork drags that fork's
whole toolkit with them. The compiler says so plainly:
`expected SecurityContext, found toolkit_security::SecurityContext`. This
assembly pins all 61 gears-rust crates to one source for exactly that reason.
Consuming #4785 early therefore means repointing the entire platform at a
personal fork — a disproportionate blast radius for a theme preference, and one
that has to be undone again later.

**C. Re-key what we already own.** Studio's `identity_user` has a `locale`
column, so language is *already* stored per person in `studio-user` and the
platform gear duplicates it. Folding theme in there too would heal that split
with no new gear.

Rejected, narrowly: it makes the eventual move back to the platform gear a
migration rather than a base-path change, and it grows the identity gear's
profile table with UI state that is not identity.

**D. Take the gear over, in our repository, as ours to develop.** Chosen.

## Decision

An in-crate gear **`studio-user-settings`** (`src/user_settings/`), and the
platform `simple_user_settings` is unlinked.

It is deliberately the same capability, not an improved one:

- the same three operations on the same resource — `GET`, `POST` (replace),
  `PATCH` (partial) on `/settings` — under `/studio-user-settings/v1`, so the
  move back is a base-path change and not a client rewrite;
- the same two fields, `theme` and `language`.

Two things differ, and they are the point:

**1. The key is the person.** Resolved through `studio-user`'s `PersonResolver`
(ADR-0014). If that resolver is unavailable the gear answers 503 rather than
falling back to the token subject: falling back silently is the exact behaviour
this gear was taken over to stop.

**2. The organization is not part of the key.** A person has one theme, not one
per organization. The row carries the platform-root tenant like every other
identity-owned record, because a person is global and the secure runner needs a
partition to scope a query to.

`max_field_length` stops being configurable (100, was a per-deployment 200).
A limit a deployment can raise is a limit every consumer must defend against
anyway, and nothing ever wanted a different number.

## What we are not doing

- **No data migration.** The old rows are keyed on subject and tenant, in
  another gear's database, and mapping them would mean reading it across a gear
  boundary. The contents are a theme and a language for a handful of accounts on
  dev environments; they are re-set once, and the alternative is machinery
  nobody will run twice.
- **No new preferences.** The temptation with an owned gear is to generalise the
  two fixed fields into a key/value bag. That is a real improvement and it
  belongs upstream, where the same two-field limitation exists — not as a
  divergence that makes the move back harder.
- **`locale` on the identity profile stays.** It is now duplicated by
  `language` here, which is a known redundancy and the first thing to settle
  before either store is called authoritative for a person's language.

## Consequences

- (+) The premise the whole identity effort rested on is finally true: sign in
  either way, get your own settings.
- (+) The redundancy is one gear, not two: the platform gear is unlinked rather
  than left running unused.
- (−) We now maintain a gear the platform also ships. The mitigation is that we
  kept the surface identical on purpose, and #4785 is already open.
- (−) `language` here and `locale` on the profile mean two places record a
  person's language.
- (−) A deployment upgrading past this loses whatever themes were stored, and
  gets a new database (`studio_user_settings`) to provision.

## The way back

Ours stops existing when all three hold:

1. **#4785 lands** on gears-rust `main`, so the platform gear can be told who a
   caller is;
2. **this assembly stops pinning** every gears-rust crate to one fork. That is
   already planned and already scoped: gears-rust publishes to public crates.io
   on every push to its `main`, 35 of the 37 crates here resolve cleanly from
   there, and the move is waiting only on `cf-gears-graph-storage` being
   published. When the 57-entry `[patch]` block goes, consuming #4785 is a
   version bump and nothing else. Until then sources cannot be mixed at all —
   patching part of the graph to git makes the crates.io gears fail to compile,
   `simple-user-settings` among them;
3. **the organization question is settled** upstream: a preference keyed on
   `(person, tenant)` still gives one human several themes, which #4785 does not
   address and this ADR deliberately does.

Then: relink `simple_user_settings`, publish Studio's `SettingsOwnerResolver`
(the impl is one method over `PersonResolver`), point the prototype's base path
back, and delete `src/user_settings/`. Whatever this gear has learned by then is
the content of the second upstream proposal.

## Verified

`cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` clean;
3 unit tests on the field-length rule, including that it counts characters
rather than bytes.

On a stand (own Postgres; the shared dev stack untouched): two static tokens
with different subjects, merged onto one person, then a theme written through
the first token and read back through the second — the same value, filed under
the person's id. Before this change the second token would have read an empty
record.

Upstream: `cargo test -p cf-gears-simple-user-settings` → 32 passed on both the
pinned base and current `main`, with four new tests covering the resolver, the
no-resolver default, a declining resolver, and a failing one.
