# Verifying the collaborative editing work

Twenty-three pull requests (#260–#282) put collaborative document editing into
the backend, the portal and the embedded IDE. This is how to check that they
actually work, in the order that makes a failure mean something.

The order matters more than usual here. **Identity is underneath everything
else**: if the IDE and the portal disagree about who you are, presence shows two
people where there is one, a comment is attributed to a stranger, "waiting on
you" waits on somebody who does not exist, and every later check fails for the
same single reason. So identity is checked first, and nothing downstream is
worth debugging until it passes.

---

## Layer 0 — are you even testing today's code?

`theia/product-ext` is hand-written JavaScript with **no build step**, which
makes it fast to change and easy to verify the wrong copy of. The session image
bakes it in, and `docker compose up` does **not** rebuild that image once the
tag exists — deliberately, it is a ten-minute build.

So a check that "fails" most often fails because the container is running
yesterday's file.

```bash
scripts/dev-up.sh          # warns when cf-studio-theia:local predates HEAD
docker compose build session-image   # when it does
```

And to be certain, ask the image rather than the checkout:

```bash
docker run --rm cf-studio-theia:local \
    grep -c 'studio-link-card' /home/theia/product-ext/src/browser/link-card-marks.js
```

A grep for something the change introduced answers "is my code in there" without
starting anything.

---

## Layer 1 — what a machine checks, in three seconds

Seven suites cover the logic the collaboration work added. They are plain
`node:assert`, no runner, no `node_modules`:

```bash
cd theia/product-ext
for t in identity collab-roster collab tasks element-anchor link-cards git-identity; do
    node test/$t.test.js || echo "FAILED: $t"
done
```

119 checks. What each one is actually defending:

| suite | the thing that would otherwise break silently |
| --- | --- |
| `identity` | a person having two identities, or an agent's write being applied as a person's |
| `collab-roster` | your own second tab showing up as a colleague; a ghost that never leaves |
| `collab` | the write claim, and "read just now ago" |
| `tasks` | `roma@example.com` producing an assignee called `@example.com` |
| `element-anchor` | an anchor that re-points every time a panel opens; an area that drifts on resize |
| `link-cards` | a card that names the wrong ticket — worse than a raw URL, because a raw URL is obviously a raw URL |
| `git-identity` | commits attributed to the container instead of the person |

The other ten suites in that directory need `jsdom`, which is not installed in a
plain checkout. They are not part of this work.

## Layer 2 — the backend gates

The thread counting (#265, #269) is Rust, and its tests want a PostgreSQL, so
they run in the image CI uses rather than against a local toolchain:

```bash
scripts/backend-check.sh test comment_threads   # 18 tests
scripts/backend-check.sh                        # fmt, clippy, build, features, test
```

**If the counts come back zero on a real repository**, check `TEXT_EXT` in
`artifact_ingest/clone.rs` includes `"jsonl"` before looking anywhere else. The
fold is correct whatever that list says, and silently useless without it — which
is exactly why the test for the extension lives next to the fold.

## Layer 3 — the prototype

```bash
npm run build:packages   # first, or the per-package suites cannot resolve
npm run test:unit
```

Four `connections-mfe` tests already fail on `main`; they are not yours.

---

## Layer 4 — the stand, with two people

Everything above is arithmetic. The product is two people in one document, and
that needs two identities: sign in as yourself in one browser, and as a second
Keycloak user in a private window. **Two tabs of the same account is not a
second person** — and proving that is itself one of the checks.

```bash
scripts/dev-up.sh
#   Portal:   http://localhost:8080
#   API/docs: http://localhost:8090/cf/docs
```

### 1. Identity — the one that has to pass first

Sign in to the portal as A, open the IDE.

- **Expect**: the collaboration strip above the document tabs shows *your portal
  name*.
- **Fails as**: a generated or anonymous name; a name you are allowed to edit;
  the same human appearing twice in the roster.

The generated name is not cosmetic. It means the IDE did not adopt the portal's
`sub` and has minted a local identity, so everything below attributes to the
wrong person.

### 2. A commit is signed by the person who made it

In the IDE, change a file, commit it, then in the IDE's terminal:

```bash
git log -1 --format='%an <%ae>'
```

- **Expect**: your portal name and verified e-mail.
- **Fails as**: the container's default — or the error that started this work,
  *"Make sure you configure your user.name and user.email in git."*

### 3. Presence, and its expiry

Sign in as B in a private window.

- **Expect**: the portal shows both of you online, each with a way to be
  reached.
- Close B's window. **Expect**: B disappears within ~12 seconds (the TTL), on
  its own, with nothing clicked.
- Open a **second tab as A**. **Expect**: still one A. A second tab is not a
  colleague.

### 4. Co-editing, above the tabs

Both open the same document.

- **Expect**: each sees the other on the one-line strip *above the open document
  tabs* — not in a left-hand panel.

### 5. A hand-off between two browsers

A types and saves. Watch B.

- **Expect**: B's editor takes the change in place; B's caret keeps its
  position; a notice names A for about five seconds.
- **Fails as**: B's own unsaved edit vanishing, or the notice naming B.

Attribution here is content-keyed, not time-keyed, on purpose: it is what stops
an agent's write from being applied as a person's.

### 6. Commenting on something that was rendered

In rich view:

- comment on a **heading, a table, an image** — without selecting any text;
- **drag a rectangle** over an image and comment on that.

Then resize the window.

- **Expect**: the rectangle stays over the same part of the picture.
- Now make the element drastically taller than it was wide. **Expect**: it
  *asks for reattachment* rather than quietly sliding the rectangle onto
  something else.

### 7. A link that says what it is

On its own line in rich view, paste a pull request URL.

- **Expect**: a line above it reading `pull request · <owner>/<repo> · #<n>`.
- Paste `https://example.com/some/page`. **Expect**: nothing happens, and the
  URL stays editable. That is the whole fallback — there is no failure path to
  test, because an unrecognised link is a link.

Nothing is fetched. Disconnect the network and the cards render identically;
that is the design, not a cache.

### 8. A comment becomes a task, and the tasks are visible

- Turn a comment into a task in one click. **Expect**: it appears under
  `## Tasks` in the document, with an assignee, in the Markdown itself.
- Open the tasks view. **Expect**: yours first, then somebody's, then nobody's,
  then done.

### 9. The portal knows what is waiting on you

With threads in the repository, let ingest run, then open the project overview.

- **Expect**: what is waiting on you, on the overview — before any notification.

### 10. A run that finishes says so

Start background work, let it end, and stay in the IDE.

- **Expect**: the IDE says it finished, without a reload.

---

## What cannot be checked, because it was not built

**Notifications leaving Studio** — requirement §10, *"you shouldn't have to go
into the product to learn about comments"*. It is blocked on a decision between
a project channel, personal e-mail and a stored inbox, each of which adds a
subsystem rather than a function. `TASKS.md` carries it. Nothing in this
document covers it, and nothing should appear to.
