# What the prototype knows that the contract does not tell it

Written for the team porting `studio-frontend-prototype` into the official
frontend. Every table below is a place where the prototype holds a fact it was
never given — copied by hand from a Rust comment, or re-derived from data it
already had. Ported as-is, each one is a place the official frontend will drift
from the backend silently.

This is not a list of things done badly. Most of them had no alternative at the
time. It is a list of what to *check* before copying, and what to ask the
backend for so the copy is not needed.

---

## 1. The root cause: our own gears skipped a pattern the platform uses

Some of `studio-backend`'s DTOs flatten a closed set of values into a
`"type": "string"` field and write the values in prose:

```json
"DocumentBindingDto.state": {
  "type": "string",
  "description": "\"detected\" | \"confirmed\" | \"manual\" | \"unknown\" | \"not_a_document\"."
}
"ProviderDto.category": { "type": "string", "description": "`source_code` \u2026 | `ai` \u2026 | `notification` \u2026" }
```

> **Correction to the first draft of this document.** It said the backend
> declared *no* enums at all. That was wrong, and the mistake is worth recording
> because it is easy to repeat: the check walked `properties[].enum` only, and
> every enum here is a **named schema** reached by `$ref`, so none were counted.
> There were 31 \u2014 twelve of them in gear DTOs (`TenantStatusDto`,
> `SharingModeDto`, `ConversionStatusDto`, \u2026).

So this is not a gap in the platform. It is an inconsistency in our own gears:
the pattern was there to copy and `studio-documents` had not. That makes the fix
cheaper than the draft suggested \u2014 nothing to ask anyone for, only something to
match.

While a field is still a bare string there are three consequences, and the
third is the one that costs:

1. No client can be generated for it. The union types in `api.ts` are
   hand-transcribed from the description.
2. Nothing fails when the backend adds a value. The old client keeps compiling.
3. A `Record<Vocabulary, \u2026>` lookup then returns `undefined`, and what happens
   next depends on whether whoever wrote it added `??`.

**Done for `studio-documents`:** `BindingState`, `DetectionSource` and
`DocStatus` now reach the contract as enums. The Rust enums had existed all
along in `model.rs`, deriving `Serialize` with the same spelling the DTOs were
building by hand \u2014 they only lacked `ToSchema`, so the DTO flattened them on
the way out and the contract lost what the code already knew.

**Still flattened**, each with an enum already sitting in the code:

| DTO field | the enum it should carry |
|---|---|
| `ProviderDto.category` | `connectors::driver::ConnectorCategory` |
| `RunDto.state` (studio-tasks) | `tasks::RunState` |
| document owner and question-kind fields | `Owner`, `QuestionKind` |

These are a bigger change than the three above, not a one-line swap: the value
arrives from the layer below as a `String` \u2014 a database column, a plugin
record \u2014 so the boundary has to parse it and decide what an unparseable value
means.

**Do, rather than ask for:** derive `ToSchema` on the enum the code already has
and stop flattening it in the DTO. That turns the tables below from copies into
generated types.

---

## 2. Backend vocabulary, copied by hand

Copying these is safe only while the backend does not change. Each is a
`Record<>` keyed by a value the backend owns.

| where | constant | keyed by | if the backend adds a value |
|---|---|---|---|
| `documents.tsx:741` | `STATE_LABEL` | `DocBindingState` | renders blank |
| `documents.tsx:752` | `STATE_TONE` | `DocBindingState` | **threw** — see §5 |
| `documents.tsx:63` | `STATUSES` | `Doc["status"]` | the status is unreachable in the UI |
| `project-overview.tsx:153` | `STATUS_TONE` | `Doc["status"]` | badge loses its colour |
| `tasks.tsx:25` | `STATES` | run state | the run is filtered out of every tab |
| `App.tsx:4081` | `WORKER_CATEGORIES` | approved worker categories | cannot be approved in the UI |
| `App.tsx:5149` | `CATEGORIES` | `ProviderDto.category` | the whole category is invisible |
| `App.tsx:5315` | `ART_TABS` | artifact node types (`gts.rs:20-31`) | the kind has no tab |

`ART_TABS` is worth a second look: the backend declares eight node types and
the prototype lists six. `repo` and `spec_finding` are deliberately absent
(they are not browsable artefacts), but nothing in the code says so — the next
person adding a node type has no way to tell a deliberate omission from a
forgotten one.

**Do:** finish §1. Until a field carries its enum, put a comment on each table
naming the Rust constant it mirrors, so a reader can diff them.

---

## 3. A second source of truth — the backend already serves this

These re-derive something the frontend has already fetched, or could.

### `notifications.tsx:35` — `NOTIFY_PROVIDERS`

```ts
const NOTIFY_PROVIDERS = ["slack", "slack_webhook", "zulip", "zulip_webhook",
                          "discord", "discord_webhook"] as const;
export function isNotificationProvider(provider: string): boolean { … }
```

`GET /studio-connector/v1/providers` returns `category` for exactly this, and
the prototype already reads it elsewhere. A notification driver added to the
backend is invisible here until somebody edits this array — and nothing points
at the array, because the symptom is a connector that simply does not appear in
the send panel.

**Port as:** join `connections` to the providers already in hand on
`category === "notification"`. No new endpoint needed.

### `gts-entities.tsx:24` — `categoryOf()`

Classifies a GTS type id by prefix matching in the browser:

```ts
if (g.startsWith("gts.cf.core.graph")) return "Graph type";
if (g.includes("authz.permission"))    return "Permission";
if (g.includes("am.tenant_type"))      return "Tenant type";
…
return "Other";
```

This is the platform's taxonomy, re-implemented against string shapes. A new
namespace falls into `Other` and looks like a deliberate classification.

**Ask for:** the category on the entity, or accept `Other` explicitly as
"this deployment has not classified it" rather than as a category.

### `components-catalog.tsx:213` — `LEGACY_KEYS`

Maps flat profile keys an older editor wrote onto current schema keys. This is
a migration living in the client: every reader must apply it or read a subset.

**Port as:** a one-off backfill, then delete. If it must stay, it belongs where
the profile is read, not where it is rendered.

---

## 4. Legitimately the frontend's

Copy these without worrying. They are presentation: a label, a colour, an
order, an icon. The backend has no opinion and should not acquire one.

| where | what |
|---|---|
| `App.tsx:589,599,3031,3778` | navigation and tab order, labels, icons |
| `documents.tsx:760,770` | `SOURCE_LABEL`, `FINDING_TONE` — **both guard with `??`** |
| `spec-quality.tsx:623` | `ROLE_COLORS` |
| `components-catalog.tsx:266,292,1905,2227` | lamp ranking, month names, node palette |
| `domain-model-graph.tsx:16` | `PALETTE` |
| `connector-logos.tsx:24` | brand marks (CC0, vendored on purpose) |
| `studio-events.ts:81` | `BACKOFF` — a client policy, not a server fact |
| `view-mode.tsx` | the `table`/`tiles` vocabulary — the portal owns these keys, and `studio-presence` says so in its own doc comment |

`SOURCE_LABEL` and `FINDING_TONE` are the pattern to copy everywhere else:

```ts
const findingTone = (severity?: string | null) =>
  FINDING_TONE[severity ?? ""] ?? { bg: "var(--muted)", fg: "var(--muted-foreground)" };
```

Its comment states the reason — *"anything else a future detector invents reads
as neutral rather than as a failure"*. That is the whole discipline: an unknown
value must render as unknown, not as absent and not as a crash.

---

## 5. One live defect, found writing this

`documents.tsx:1993` reads the tone table with no fallback:

```ts
background: STATE_TONE[selected.state].bg,
```

A binding state the frontend does not know throws
`Cannot read properties of undefined (reading 'bg')` and takes the Specs side
panel down with it. Its neighbours two lines below — `SOURCE_LABEL`,
`FINDING_TONE` — guard; this one was missed. Fixed in the same change as this
document.

---

## 6. What would make the port comfortable

In the order that buys the most:

1. **Finish §1.** Three fields carry their enum now; `ProviderDto.category` and
   `RunDto.state` are the two that matter next, and both have an enum waiting in
   the code. Each one turns a hand-copy in §2 into a generated type, and a
   backend change into a compile error rather than a blank cell.
2. **`category` used rather than re-derived** (§3). One join replaces one
   array that nobody will remember to edit.
3. **A fallback on every vocabulary lookup.** Cheap, and it converts the whole
   class of failure from "crash or blank" into "renders as unknown".

Until (1), the honest rule for the port: **a `Record<>` keyed by a backend
value must have a `??`, and a comment naming the Rust constant it mirrors.**
Anything else is a copy that cannot be checked.

§7 is the same sweep with a wider net: not vocabularies, but everything else
the prototype holds up by hand.

---

## 7. Beyond vocabularies: what else is propped up

Same sweep, wider net. Two things it is worth saying first, because they change
how to read the rest: there are **no silent `catch {}` blocks** and **almost no
`TODO`/`FIXME`** in the prototype. What follows is not neglect — most of it is
a client doing a job because nothing else offers to.

### 7.1 The browser does a join the backend could do — three times

This is the largest one by a distance.

| where | what it builds |
|---|---|
| `documents.tsx:891` | every ingested text file, as classification candidates |
| `documents.tsx:954` | `node id → repo id` |
| `App.tsx:5970` | `node id → repo id` — **the same map, on another screen** |

Each walks the **whole** `file` node collection at 200 per page. On the
project this was measured against — 5,785 files — that is 29 requests per walk,
and opening Specs and Sources runs all three.

`GET /studio-artifact-ingest/v1/nodes` offers type, scope, repo, sort, search
and pagination, but **no projection**: every node arrives whole. File content
itself is not in there (`bounded_payload` strips `text` on the way into the
graph) but a `text_excerpt` of up to 8,000 characters is, so the browser
downloads prose to extract two id strings per file.

The code says why, at `App.tsx:5965`:

> *Two listings rather than one join, because the graph does not hold the
> binding: the documents gear does, and the only thing tying them together is
> the file node's id.*

**Fix on the backend, one of:**

- put the repository on `DocumentBindingDto` — the gear already has `node_id`,
  so the join is one query there and none here; or
- give the nodes endpoint a projection (`?fields=`), so a caller can ask for
  ids without the prose.

The first removes all three walks. The second removes the payload but not the
round trips.

### 7.2 `any` where a contract should be — 25 of 36 in one file

`spec-quality.tsx` holds 25 of the prototype's 36 type escapes. Not
carelessness: the spec-quality service declares only its four **request**
bodies in its OpenAPI, so every result shape is read defensively. The code says
so where it matters, and `detectTraceability` carries a `recognised` flag for
exactly this — without it an unfamiliar shape and a genuinely unreferenced
doc-set both render as "no references".

**Ask the spec-quality service for its response schemas.** Until then the `any`
is the honest spelling, and the `recognised` pattern is the one to copy.

### 7.3 One URL that only ever worked on a developer's machine

`App.tsx` opened the identity provider's console at a literal
`https://localhost:8443/admin/`. Anywhere but the local stand, that button
opened the reader's own port 8443 — a link that always rendered and never
worked.

Two lines below it, `oidc.ts` does the same family of URL correctly, through
the runtime-env mechanism (`window.__STUDIO_ENV__`, regenerated at container
start). **Fixed in this change**: the console is now derived from the issuer —
Keycloak serves `/admin/` from the same origin as `/realms/<realm>`, so one
configured value answers both and a second could only disagree with the first.
With no issuer configured the section does not render, which is the honest
answer.

### 7.4 A CDN in the render path

`components-catalog.tsx:2074` loads Mermaid from `cdnjs.cloudflare.com` at
runtime. In a closed network the diagram never renders, and the failure surfaces
as `mermaid unavailable` rather than as "this deployment has no internet".
Vendoring it is the fix; until then it is worth knowing which feature goes dark
behind a firewall.

### 7.5 Folds that are really queries

Six modules compute in the browser what one endpoint could answer:
`rollups.ts`, `source-activity.ts`, `spec-rows.ts`, `spec-pipeline.ts`,
`analysis.ts`, `activity.ts`.

These are **not** a problem to fix before porting — each is pure, tested, and
documented, and that is why they were put in modules of their own rather than
inside a component. They are listed because each is a candidate for an endpoint
later, and because a second client (the official frontend) implementing them
independently is how two screens start disagreeing about the same number.

If any of them moves server-side, the test file next to it is the specification
to move with it.
