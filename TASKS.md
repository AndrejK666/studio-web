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
