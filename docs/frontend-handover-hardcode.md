
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
