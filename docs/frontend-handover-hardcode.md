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

## 1. The root cause: the contract carries no vocabularies

`studio-backend` declares **no enums**. Every closed set of values — binding
states, document statuses, connector categories, run states — reaches the
frontend as `"type": "string"` with the values written in prose:

```json
"DocumentBindingDto.state": {
  "type": "string",
  "description": "\"detected\" | \"confirmed\" | \"manual\" | \"unknown\" | \"not_a_document\"."
}
"DocumentDto.status":  { "type": "string", "description": "\"draft\", \"review\" or \"approved\"." }
"ProviderDto.category": { "type": "string", "description": "`source_code` … | `ai` … | `notification` …" }
```

Measured, not assumed: walking `components.schemas` in the live
`/cf/openapi.json` finds **zero** `enum` declarations.

Three consequences, and the third is the one that costs:

1. No client can be generated for these. The union types in `api.ts` are
   hand-transcribed from the description string.
2. Nothing fails when the backend adds a value. The old client keeps compiling.
3. A `Record<Vocabulary, …>` lookup then returns `undefined`, and what happens
   next depends on whether whoever wrote it added `??`.

**Ask for:** `enum` on these fields in the OpenAPI. It costs the backend an
attribute and turns every table below from a copy into a generated type.

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

**Ask for:** enums (§1). Until then, a comment on each table naming the Rust
constant it mirrors, so a reader can diff them.

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

1. **`enum` on the vocabulary fields** (§1). Turns §2 from eight hand-copies
   into generated types, and makes a backend change a compile error rather than
   a blank cell.
2. **`category` used rather than re-derived** (§3). One join replaces one
   array that nobody will remember to edit.
3. **A fallback on every vocabulary lookup.** Cheap, and it converts the whole
   class of failure from "crash or blank" into "renders as unknown".

Until (1), the honest rule for the port: **a `Record<>` keyed by a backend
value must have a `??`, and a comment naming the Rust constant it mirrors.**
Anything else is a copy that cannot be checked.
