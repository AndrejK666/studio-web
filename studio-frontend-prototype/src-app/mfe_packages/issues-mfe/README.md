# issues-mfe — the Issues kit

Project › Issues, carried over from the prototype (ADR-0069): everything to
decide about a project in one table — what stops a build, what to look at,
how the documentation could be better, what was decided. A built-in kit
(`project-issues`, ADR-0068 §7) and, until a platform administrator removes
it, a base kit (ADR-0069 §4).

- The queue, its groups (`blocks`, `look`, `decided`), each row's passages and
  the actions it offers are the server's (`GET /studio-documents/v1/spec-model/issues`),
  and so is the verdict (`GET /spec-model/readiness`) and every fact's review
  key (`fact_key` on `GET /spec-model`). The prototype computed all three in
  the browser; none of that is carried here.
- `src/model/doc-quality.ts` — the documentation's thin places (the table's
  "Improve the docs" rows), still read off the model in the browser, moved
  unchanged with the modules it needs (`spec-model.ts`, `domain-layers.ts`,
  `glossary-view.ts`, `saved-entities.ts`, `build-eta.ts`, and `domain-map.ts`:
  the model-map half of the prototype's `domain-model-views.ts`), each with
  its tests.
- `src/model/issue-rows.ts`, `src/model/reviews.ts` — the table's rows over
  the server's queue, and reviews looked up by the server's key.
- `src/api/IssuesApiService.ts` — the reads and writes (studio-documents;
  the organization's members and their GitHub logins from studio-user).
- `src/screens/issues/` — the screen.
