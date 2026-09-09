# Queued notifications — studio-notify

The connectors in [notification-connectors.md](./notification-connectors.md)
can post a message while a request waits for it. This gear is the other half:
it validates a notification and queues it, and delivery happens afterwards
with retries. Use it for anything that must not be lost; keep using
`POST /studio-connector/v1/connections/{id}/messages` for "send a test message
and tell me what Slack said".

## One route, and the run is the record

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "http://localhost:8090/cf/studio-notify/v1/messages" -d "{
    \"connection_id\": \"$CONN\",
    \"tenant_id\": \"$ORG\",
    \"target\": \"C01ABCDEF\",
    \"title\": \"Spec quality gate failed\",
    \"text\": \"2 of 7 checks are red on *PRD-14*.\",
    \"link\": \"http://localhost:8080/projects/14/artifacts\",
    \"idempotency_key\": \"prd-14-gate-2026-09-09\"
  }"
# → 202 {"run_id": "…", "poll": "/studio-tasks/v1/runs/…"}
```

Everything after that is `studio-tasks`
([background-work.md](./background-work.md)):

```bash
# what happened to it
GET  /studio-tasks/v1/runs/{run_id}

# what needs attention
GET  /studio-tasks/v1/runs?task_type=notify.deliver&state=failed

# put a failed one back on the queue, after rotating a token or inviting the bot
POST /studio-tasks/v1/runs/{run_id}/retry
```

This gear owns **no database**. The message is the payload of a
`notify.deliver` run and that run is the whole history: its state, its
attempts, its `summary` (`delivered to C01ABCDEF (1757…)`) or its `last_error`
in the platform's own words.

That is not tidiness for its own sake. It used to keep a
`studio_notify_deliveries` table beside its own outbox, which was safe because
both were in one database and one transaction. Moving the queue into
`studio-tasks` and keeping the table would have meant writing the record in one
database and the queue entry in another — and a crash between those two writes
is exactly the lost notification the queue exists to prevent. One system of
record, one commit.

## What guarantees what

| Property | How |
| --- | --- |
| Not lost once accepted | The run row and its queue entry are written in **one transaction** in `studio_tasks`. Either both commit or the request fails and nothing was accepted. |
| Survives a restart | The queue is rows in PostgreSQL, not memory. A crash mid-delivery leaves the run queued; the next process picks it up when the lease expires. |
| Retried | Exponential backoff, up to **8 attempts** — more than the task default, because a chat platform's refusals skew transient and giving up after five backoffs would drop a message the platform was only asking us to slow down about. |
| Not retried pointlessly | A revoked credential, a channel the bot is not in, a connection since deleted — refused once and dead-lettered, with the reason on the run. |
| Repeat-safe accept | `idempotency_key` makes a *caller's* own retry return the first run instead of queuing a second. |
| **Possibly delivered twice** | The processor is leased (at-least-once). A lease expiring after Slack accepted the message but before the ack committed hands it to another worker, and none of the three platforms offers an idempotency key on a post. **Losing a message is not possible; duplicating one in that window is.** |

## What the accept path refuses, and why there

Three things are checked with the *caller's* own context, while there is still
a request to answer with a 400 rather than a dead letter nobody is watching:

- **A connection that cannot deliver** — wrong id, unreadable credential, or a
  source-host connection that has no channels.
- **A `personal`-scoped connection.** credstore keeps that credential readable
  only by its owner, and a queued delivery runs as a service identity that is
  not its owner. Refused by name, pointing at the synchronous route.
- **A target where there is no choice, or none where there is.** An incoming
  webhook's channel is fixed in its URL; a bot token reaches many and must be
  told which.

## Why PostgreSQL and not Redis

Because the enqueue has to be part of the transaction that caused it. Every
cause Studio has lives in PostgreSQL, and putting the queue in a different
system turns one commit into two writes that can disagree — the exact failure a
durable queue is meant to prevent.

Throughput is not the deciding factor either way. The ceiling here is the
platforms': Slack accepts roughly one `chat.postMessage` per second per
channel, Discord about five per five seconds. That is orders of magnitude below
what one PostgreSQL absorbs, so Redis would buy a capacity nothing can use, at
the price of a second stateful system in compose, dev, test and Kubernetes,
with its own backup story and its own failure mode. Durability is worse there
too: with the usual settings Redis can lose its last writes on a crash, and
`appendfsync always` gives that back by removing the speed it was chosen for.

The platform agrees, for what it is worth: in the event-broker's design Redis
appears only as one possible ClusterCapabilities provider — a cache tier
alongside K8s ConfigMaps and Postgres LISTEN — never as the system of record.

Redis would earn its place for state this design deliberately does not keep: a
rate-limit budget shared across replicas, or a cross-replica deduplication
window. Both are ephemeral, and neither is needed while one process holds the
queue.

## Why not the event-broker

`cf-gears-event-broker` is a durable, tenant-scoped, replayable log, and its
PRD names notification fan-out as a target pattern. It is still the wrong tool
for *delivery*, for three reasons its own design states:

- `cpt-cf-evbk-principle-no-auto-retry` — "the broker does not retry failed
  writes or consumption. Retry logic is the client's responsibility."
- consumer cursors are ephemeral (cache-backed); "consumers that need durable
  progress track offsets in their own store."
- no durable storage backend ships yet — the tree carries the `builtin`
  in-memory one.

So a delivery worker would have to bring its own retry, its own dead letters
and its own durable progress — i.e. everything `studio-tasks` does — and the
broker would add a hop. Where it will fit is *audit*: publishing
`notification.delivered` / `notification.failed` as events for anything that
wants to watch. That is additive and not built.

## Ordering

Notifications are partitioned by connection, so one connection's messages stay
in order relative to each other — a "build finished" cannot overtake its "build
started". The cost is head-of-line: an undeliverable message delays the ones
behind it on its partition until it gives up, which is what the attempt cap
bounds.

## Deploying

```yaml
  studio-notify:
    config: {}
```

No `database:` block — this gear has no storage. It does need `studio-tasks`
configured: without it the accept route answers 400 saying the queue is
unavailable, and nothing is queued.

## Still to do

- **Real delivery is still unverified.** Everything up to the platform call is
  exercised on a live stack; the call itself needs a genuine Slack, Zulip or
  Discord credential, and the URL guard (correctly) refuses a local stub.
- **A digest, and event routing.** Nothing subscribes to anything: a
  notification is queued because a caller asked. A schedule can already fire
  `notify.deliver` with a fixed payload — that is how "post this every morning"
  works today — but "when a spec-quality gate fails, post to #eng" needs a rule
  engine that does not exist.
- **No direct messages to a person.** That needs a mapping from a Studio
  subject to a platform account, which is `studio-identity`'s job (ADR-0012).
