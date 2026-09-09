# Background work — studio-tasks and studio-scheduler

Two gears. `studio-tasks` runs work durably; `studio-scheduler` decides when.
They are separate so the scheduler can be switched off without taking
background work with it, and so a bug in cron arithmetic cannot stop a
repository import.

## What was here before

| Piece | Before |
| --- | --- |
| Time triggers | Nothing in the platform's 35 gears schedules anything. Two hand-rolled `tokio::time::interval` loops in-assembly: `studio-session`'s reaper and the platform gateway's directory sync. Both fire in *every* process. |
| Task tracking | Three separate in-memory registries — `connectors::graph_sync_tasks`, `artifact_ingest::tasks`, `components_catalog::tasks` — each with its own `Mutex<HashMap<String, TaskRecord>>`, its own `TaskStatus`, its own retention and its own `GET …/tasks/{id}`. All lost on restart; none cancellable; none retryable. |
| Durable execution | `toolkit-db`'s transactional outbox, in use by `studio-notify` since the notification queue landed. |

## Why not serverless-runtime

The platform *does* define a `Schedule` (`gts.cf.core.sless.schedule.v1~`, with
cron/interval expressions, missed policies and concurrency control) — inside
the `serverless-runtime` gear. That gear cannot be used today and would not
help if it could:

- **It ships no code.** Both gears-rust checkouts contain only `docs/` under
  `gears/serverless-runtime` — no `Cargo.toml`, no `.rs` files, not a
  workspace member.
- **Its host runs no timer, by design.** From its own thin-host ADR: "The host
  runs no scheduler, polling loop, or timer mechanism — each plugin uses its
  backend's native scheduling primitives (Temporal Schedule API and signals,
  EventBridge Scheduler with SQS, Azure Durable native timers)." Adopting it
  for cron means adopting Temporal.
- **Its scope is twenty times ours.** Sandboxed runtimes, function versioning,
  IO schemas, quotas, webhook triggers, an MCP endpoint. We need the trigger.

So the **vocabulary is borrowed and the mechanism is not**: `{kind: cron |
interval, value}`, an IANA `timezone`, `concurrency: allow | forbid | replace`,
`missed_policy: skip | catch_up | backfill` with `max_catch_up_runs`, and a
table keyed `(tenant_id, name)`. A schedule written today moves to that gear as
data if it ever lands.

## studio-tasks

A run is a row in `studio_tasks_runs`; executing it is an entry in the
`studio_tasks_outbox_*` family. **Both are written in one transaction**, which
is what makes an accepted run impossible to lose — the same argument as
`docs/queued-notifications.md`, and the reason the queue is PostgreSQL and not
Redis.

A task type is `<gear>.<verb>` and is bound to code by a handler:

```rust
#[async_trait]
impl TaskHandler for MyWork {
    fn task_type(&self) -> &'static str { "mygear.dothing" }
    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        ctx.progress("phase one").await;
        if ctx.cancelled() { return TaskOutcome::Done(Some("stopped".into())); }
        TaskOutcome::Done(Some("42 things".into()))
    }
}
// during the owning gear's init:
crate::tasks::registry::register(Arc::new(MyWork::new(...)))?;
```

The registry is a process-global rather than a ClientHub client, deliberately:
a handler's owner has no reason to depend on `studio-tasks`, so publishing it
on the hub would be a race with gear init order.

`TaskOutcome::Retry` gets exponential backoff up to five attempts, then the
dead-letter table. `Failed` goes there immediately. Handlers run **leased**, so
they may take as long as they need and must be idempotent — an expired lease is
redelivered.

Routes: `GET /studio-tasks/v1/runs` (filter by `state`, `task_type`),
`GET …/runs/{id}`, `POST …/runs/{id}/cancel`, `POST …/runs/{id}/retry`,
`GET …/task-types`. There is deliberately **no** route that enqueues an
arbitrary task type with an arbitrary payload.

Cancellation is cooperative and polled: the endpoint sets a flag, a queued run
will not start, and while a handler runs the dispatcher re-reads the flag every
five seconds and flips the handler's token. A handler that never checks cannot
be stopped — which is why the endpoint answers 202, not 200.

## studio-scheduler

One ticker, a minute apart, under a **PostgreSQL advisory lock** (`Db::try_lock`)
— so a second replica does not double-fire. That is the only new mechanism
here; no leader election, no Redis, no cluster provider.

Firing is at-least-once and runs are exactly-once. The scheduler and the task
gear have separate databases, so "enqueue the run" and "record that it fired"
cannot be one transaction; a crash between them re-fires. Every firing carries
the idempotency key `<schedule_id>:<scheduled_for>`, which makes the repeat the
same run. The missed-schedule policy then reduces to *which* `scheduled_for`
values a tick enqueues at all.

```bash
H="Authorization: Bearer $TOKEN"
B=http://localhost:8090/cf/studio-scheduler/v1

# every 15 minutes
curl -s -X POST -H "$H" -H 'Content-Type: application/json' "$B/schedules" -d '{
  "name": "catalogue-refresh",
  "task_type": "components.refresh",
  "expression_kind": "interval",
  "expression": "PT15M",
  "concurrency": "forbid"
}'

# 03:17 UTC nightly, running each missed night up to three
curl -s -X POST -H "$H" -H 'Content-Type: application/json' "$B/schedules" -d '{
  "name": "nightly-graph-sync",
  "task_type": "connector.graph_sync",
  "payload": {"connection_id": "…", "repo_full_path": "org/repo"},
  "expression_kind": "cron",
  "expression": "17 3 * * *",
  "missed_policy": "backfill",
  "max_catch_up_runs": 3
}'

curl -s -X POST -H "$H" "$B/schedules/$ID/run-now"   # the human trigger
```

`run-now` is the only way a person starts background work through the API, and
that is on purpose: the schedule already names a validated task type and
payload.

### Two limits stated rather than hidden

- **UTC only.** `timezone` is in the contract from day one and validated:
  anything but `UTC` is refused with a message explaining why. Evaluating a
  local schedule correctly needs a tz database to handle the wall-clock hours
  that repeat or do not exist at a DST boundary, and silently treating
  `Europe/Belgrade` as UTC would put a daily job an hour out for half the year.
- **Schedules are platform-level.** `toolkit-db`'s secure ORM has no
  cross-tenant read — `all()` and `one()` exist only on a *scoped* select — so
  a single ticker cannot scan every tenant's schedules. Schedules therefore
  belong to the platform tenant (`owner_tenant_id`, which must match
  account-management's `bootstrap.root_id`), and a schedule that acts on a
  workspace's data names it in the payload. Per-tenant self-service schedules
  need the ticker to enumerate tenants from account-management; the table is
  already keyed `(tenant_id, name)`, so that is an additive change.

## The one task type that ships

`tasks.retention_sweep` prunes finished runs (default 30 days) and cleans up
`resolved`/`discarded` dead letters. A `tasks-retention-sweep` schedule at
`17 3 * * *` is registered at boot with `ensure`, which does **not** overwrite:
an operator who changed the cadence or disabled it keeps that across restarts.

It prunes the tenant its run belongs to — the platform tenant, where every
scheduled run accumulates. Runs created inside a workspace's tenant are not
touched, for the same cross-tenant-write reason as above.

## Deploying

```yaml
  studio-tasks:
    database: { server: "pg_main", dbname: "studio_tasks" }
    config: {}

  studio-scheduler:
    database: { server: "pg_main", dbname: "studio_scheduler" }
    config:
      owner_tenant_id: "00000000-0000-0000-0000-000000000001"
      tick_seconds: 60
      enabled: true
```

`backend-bootstrap` creates both databases from those blocks. Drop the
`studio-tasks` block and its API answers 503 and nothing is queued; drop
`studio-scheduler`'s and nothing fires on its own while the queue keeps
working. PostgreSQL only — `config/dev.yaml` deliberately configures neither.

## Still to do

- **Four migrations onto this substrate**, none of which needs a new decision:
  `studio-notify`'s own outbox becomes the `notify.deliver` task type, and the
  three in-memory registries (`connectors::graph_sync_tasks`,
  `artifact_ingest::tasks`, `components_catalog::tasks`) become handlers. Each
  touches a working gear's REST DTOs and wants its own verification pass, which
  is why they are not bundled in with the substrate.
- **Replacing the hand-rolled loops.** `studio-session`'s reaper is a schedule
  waiting to happen (and today it fires in every replica).
- **Per-tenant schedules**, and a sweep that reaches other tenants' runs — both
  blocked on enumerating tenants, as above.
