# Queued notifications — studio-notify

The connectors described in [notification-connectors.md](./notification-connectors.md)
can post a message while a request waits for it. This gear is the other half:
it takes a notification, writes it down, and answers — delivery happens
afterwards, from a queue, with retries, and whatever cannot be delivered ends
up in a dead-letter table rather than nowhere.

Use it for anything that must not be lost. Keep using
`POST /studio-connector/v1/connections/{id}/messages` for "send a test message
and tell me what Slack said".

## What guarantees what

| Property | How |
| --- | --- |
| Not lost once accepted | The delivery row and the queue entry are written in **one transaction**. Either both commit or the request fails and nothing was accepted. |
| Survives a restart | The queue is rows in PostgreSQL, not memory. A crash mid-delivery leaves the message queued; the next process picks it up when the lease expires. |
| Retried | Exponential backoff, up to 8 attempts, on anything that might behave differently in a minute (rate limits, 5xx, timeouts, and anything unrecognised). |
| Not retried pointlessly | A credential that was revoked, a channel the bot is not in, a connection that has been deleted — refused once and dead-lettered, with the platform's own words on the row. |
| Repeat-safe accept | Pass `idempotency_key`; a second request with the same key in the same tenant returns the first delivery instead of queuing another. |
| **Possibly delivered twice** | The processor is leased (at-least-once). A lease that expires after Slack accepted the message but before the ack committed hands it to another worker. The recorded state narrows this to the width of one ack, but none of the three platforms offers an idempotency key on a post, so a duplicate in that window is possible. **Losing a message is not.** |

## Why PostgreSQL and not Redis

Because the enqueue has to be part of the transaction that caused it. Every
cause Studio has lives in PostgreSQL, and putting the queue in a different
system turns one commit into two writes that can disagree — which is the exact
failure a durable queue is meant to prevent.

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
and its own durable progress — i.e. everything this gear does — and the broker
would add a hop. Where it will fit is *audit*: publishing
`notification.delivered` / `notification.failed` as events for anything that
wants to watch. That is additive and not built.

## The queue is not ours either

`toolkit-db` ships the transactional outbox: incoming → sequencer → outgoing →
processor, leased and transactional handler modes, exponential backoff on
`Retry`, a dead-letter table on `Reject`, `FOR UPDATE SKIP LOCKED` for
partition locking. This gear supplies a handler, a table prefix and a partition
count, and implements no queue of its own. We are its first adopter in this
assembly.

Two tables, two jobs, one database:

```text
studio_notify_deliveries      -- the history: what was asked, what happened
studio_notify_outbox_*        -- the queue (toolkit-db's own tables)
```

The queue is append-only, acks by advancing a cursor and vacuums what it has
processed, so it cannot answer "what happened to the message I sent an hour
ago". The history can, and is tenant-scoped, so a person sees only their own.
The queue payload is a tenant id and a delivery id — never a copy of the
message, which would go stale against the row.

## Ordering, and what it costs

Deliveries are partitioned by connection (FNV-1a over the connection id, four
partitions), so one connection's messages stay in order relative to each other
— a "build finished" cannot overtake its "build started". The cost is
head-of-line: an undeliverable message delays the ones behind it on its
partition until it gives up, which is what bounds the 8-attempt cap.

## Who delivers

A queued delivery is performed minutes later by a process with no request, so
it cannot act as the person who asked — and does not try. Nothing persists the
caller's bearer token. The worker acts as `studio-notify` itself, scoped to the
tenant on the delivery row.

The authorization that matters happens at accept time against the caller's own
context: the connection is resolved and its credential read, so an unusable
connection is a 400 while there is still a request to answer.

One consequence is worth knowing: a **`personal`-scoped connection cannot be
queued**. credstore keeps a personal credential readable only by its owner, and
the worker is not its owner. The accept path refuses it by name and points at
the synchronous route, rather than letting it become a dead letter that says
"not readable".

## Using it

```bash
TOKEN=...   # a Studio access token
CONN=...    # a workspace- or organization-scoped notification connection
ORG=...     # the tenant that owns it

# Queue one. Answers 202 with the delivery id.
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "http://localhost:8090/cf/studio-notify/v1/messages" \
  -d "{
        \"connection_id\": \"$CONN\",
        \"tenant_id\": \"$ORG\",
        \"target\": \"C01ABCDEF\",
        \"title\": \"Spec quality gate failed\",
        \"text\": \"2 of 7 checks are red on *PRD-14*.\",
        \"link\": \"http://localhost:8080/projects/14/artifacts\",
        \"idempotency_key\": \"prd-14-gate-2026-09-09\"
      }"

# What happened to it
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8090/cf/studio-notify/v1/messages/$ID?tenant=$ORG"

# What needs attention
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8090/cf/studio-notify/v1/messages?tenant=$ORG&state=failed"

# Put a failed one back on the queue — after rotating the token, or after
# inviting the bot to the channel
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8090/cf/studio-notify/v1/messages/$ID/retry?tenant=$ORG"
```

`state` is `queued` (accepted, or waiting for the next attempt), `sent`, or
`failed` (given up on). `attempts` and `last_error` say how it is going.
`retry` refuses a delivery that was already sent — retrying it would post it
twice — and one that is still queued, which has not given up yet.

## Deploying it

The gear needs its own database, declared in the profile:

```yaml
  studio-notify:
    database:
      server: "pg_main"
      dbname: "studio_notify"
    config: {}
```

`backend-bootstrap` creates the database from that block on every start, and
the gear's migrations create both table families. Remove the block and the gear
stands down with a warning: the notify API answers 503 and nothing is queued,
while the synchronous connector route keeps working.

PostgreSQL only. `config/dev.yaml` deliberately has no block — the outbox's
PostgreSQL path relies on `FOR UPDATE SKIP LOCKED`, which SQLite cannot offer.
Use `config/postgres.yaml` to exercise queued notifications locally.

## What is still not here

- **No event routing.** Nothing subscribes to anything: a notification is
  queued because a caller asked for one. Rules of the shape "when a
  spec-quality gate fails, post to #eng" are a separate concern, and this
  gear's accept route is the contract they would use.
- **No scheduling.** A delivery goes out as soon as the queue reaches it.
  There is no "send at 09:00" and no digest.
- **No retention sweep for deliveries.** Nothing prunes
  `studio_notify_deliveries` yet. `studio-tasks` now has a nightly
  `tasks.retention_sweep` for its own runs and dead letters (see
  [background-work.md](./background-work.md)); this table needs the same, which
  arrives with the migration of this gear's queue onto that substrate.
- **No direct messages to a person.** That needs a mapping from a Studio
  subject to a platform account, which is `studio-identity`'s job (ADR-0012).
