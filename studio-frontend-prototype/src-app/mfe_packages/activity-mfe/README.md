# activity-mfe — the Activity kit

Project › Activity and Project › Timeline, carried over from the prototype
(ADR-0069). Activity is the `project-activity` kit's and Timeline the
`project-lifecycle` kit's (ADR-0071 §6, step 4): built-in kits (ADR-0068
§7) and, until a platform administrator removes them, base kits (ADR-0069 §4).

- `src/model/activity.ts` — the prototype's `activity-filter.ts` (runs of one
  check folded into one row) and the choices `activity-view.tsx` made inline.
- `src/model/timeline.ts`, `src/model/fields.ts` — the rules of the
  prototype's `project-timeline.tsx` and the pure parts of its domain runtime.
- `src/api/ActivityApiService.ts` — the activity feed
  (`studio-artifact-ingest`) and the Studio domain model's `types`, `query`
  and `mutate` (`studio-domain-model`).
- `src/screens/activity`, `src/screens/timeline` — the two sections, in one
  entry (`ActivityRoot` switches on the section).

Activity needs nothing but its kit. The Timeline shows `milestone`, which its
own kit, project-lifecycle, brings: it needs no other kit's type, and shows
wherever project-lifecycle applies. Opened from an old address where it does
not, it says so instead of failing.
