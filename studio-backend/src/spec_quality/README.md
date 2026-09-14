# studio-spec-quality

A thin, authenticated wrapper over the external spec-quality service — the
detector API that judges whether a specification is any good.

## Why it exists

The upstream service analyses specification documents with four asynchronous
detectors:

| Detector | Asks |
|---|---|
| `bloat` | is this duplicated across documents |
| `purpose` | what role does each section play, and does the document meet its purpose gate |
| `leak` | does foreign content belong here |
| `traceability` | do the identifiers form a graph, or has the thread drifted |

It authenticates with **its own** shared secret. Handing that secret to every
caller would mean handing it to the browser. So this gear exposes the same
endpoints under the Studio gateway and forwards verbatim, attaching the
server-held key: callers authenticate with their normal Studio token and the
spec-quality key never leaves the backend.

## The submit is a passthrough; the wait is a run

Bytes in, bytes out: a submit forwards the caller's body verbatim, because what
a detector accepts is between the caller and the upstream and a wrapper that
parsed the payload would have to be taught each detector's schema.

The other half used to be forwarded too — the upstream is asynchronous, and the
caller polled `GET /v1/tasks/{id}` until a verdict appeared. That made every
minutes-long analysis something the browser had to stay open for, and left the
assembly no record that the work had happened. So the wait is a
[`../tasks`](../tasks) run now:

| Task type | Does |
|---|---|
| `spec_quality.analyze` | watches one submitted analysis to its verdict |
| `spec_quality.analyze_batch` | runs one detector over a document set, in turn |

Both announce every transition on [`../studio_events`](../studio_events), so a
caller subscribes as `subject_type: task_run` instead of polling. `analyze`
stores the detector's result on the run; `analyze_batch` deliberately does not
— a run's `result` is uncapped and broadcast to the whole tenant, so a sweep
names each document's upstream task and the caller reads the verdicts it wants.

The gear still decides nothing about what a verdict means. That is
[`../documents`](../documents)' and its callers', by design.

The state it keeps is one `reqwest` client and the upstream key; a restart
loses nothing, and the runs survive it because they are rows.

## REST

| Method + path | Does |
|---|---|
| `POST /analyze/{bloat\|purpose\|leak\|traceability}` | submit one analysis; answers with the run watching it |
| `POST /analyze-batch` | run one detector over a set of documents, as one run |
| `GET /tasks/{task_id}` | read one upstream submission (the verdict itself) |
| `GET /tasks` | recent submissions |
| `GET /health`, `GET /status` | is the upstream up, and what it reports about itself |

Note the route prefix is `/cf/spec-quality/v1/…`, not `/cf/studio-spec-quality/…`.

## In the assembly

- Gear `studio-spec-quality`, capabilities `[rest]`, no gear deps.
- Config section `gears.studio-spec-quality`; `base_url` and the key come from
  the environment.
- The documents it judges are [`../documents`](../documents)'.
