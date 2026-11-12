# @constructor-studio/mfe-shared

What more than one MFE of this repository needs, in one place: the host plumbing
(theme, language, the organization in scope), the studio-connector client, the
`studio-tasks` and `studio-events` clients with the run follower built on them,
the parser for the gears' RFC 7807 refusals, and a list's state in the address
(`lists/listState.ts`, the prototype's `list-state.ts`: search, filters, sort
and page under a per-list prefix, the shell's own query entry kept byte for
byte, and the list's part taken out when it leaves the screen).

**This is source, not a built package.** `exports` points at `src/index.ts` and
there is no `dist`: both consumers are bundlers (`moduleResolution: "bundler"`
for `tsc`, vite for the build), so each MFE compiles this code into its own
bundle. That is deliberate — a `dist` here would be one more thing that goes
stale between branches while `dev:all` rebuilds only the MFEs.

**One import is built output.** `tasks/StudioEventsApiService` takes
`SseAuthPlugin` from `@gears-frontx/frontx-template-shell`, which resolves to the
shell's `dist-lib`. After a change to `src/api/sse` or `SseAuthPlugin`, run
`npm run build:package`: `dev:all` does not rebuild it. This lasts until the
transport moves into FrontX.

**It does not touch MFE isolation.** Nothing here is added to any MFE's
`sharedDeps`, so nothing becomes a runtime singleton: every MFE realm keeps its
own compiled copy and its own instances, exactly as it already does with
`@gears-frontx/ui-kit`. What crosses a realm boundary is still only what goes
through `globalThis`: the QueryClient, which the framework hands over, and the
host session, which the shell publishes (`sharedAuthTransport`) under the key
its `dist-lib` exports, `SHARED_AUTH_SESSION_SYMBOL`.

**What belongs here:** code that is *byte-identical* in two or more MFEs. If one
MFE needs to diverge, move that piece back into it. Do not add a flag or an
option to the shared version — that is how this folder turns into a dumping
ground whose every change can break every MFE at once.

**Counts in translations.** FrontX's `t` fills `{param}` and picks no plural
form, so a count goes through `t.count(key, n)` from `createText`: it reads
`key_one`, `key_few` or `key_many` by the plural rule of the language in use,
with `{count}` filled. `_one` carries `{count}`, never a literal `1` — Russian
21 is "one" too. The language's own rule applies only to a language whose
dictionaries are translated, `TRANSLATED_LANGUAGES` in `screenText.ts` (en and
ru); any other reads its dictionary, an English copy today, by the English rule.
Add a language there once its dictionaries are translated, with its `_few`
forms. Without `_few` a dictionary's `_many` is read; English never has one, so a
locale missing `_few` does not fall through to English.

The build scripts skip this directory on purpose: `EXCLUDED_PACKAGES` in
`scripts/lib/mfe-tools.ts` holds the name `shared`, so `build:mfes` and
`dev:all` never mistake it for an MFE. `scripts/run-mfe-type-checks.mjs` does
pick it up, through the `type-check` script above.

## Lists on DataGrid (#1076)

Every list tab draws its rows with the kit's `DataGrid`, the way the project's
Specs tab does. `lists/grid/` holds what they share, imported from its own
entry, `@constructor-studio/mfe-shared/grid` (`src/grid.ts`): the package's
main entry stays free of the kit's DataGrid, so the shell and the MFEs without
a list do not load it (a test that re-imports the package per case would pay
for it every time). It carries CSS modules:
each MFE's build bundles them into its own stylesheet, as it does its own.

- **`ListGrid`**: the grid with the plugins every list has, in one place: text
  search (`search`, the placeholder; omit it for none), quick filters
  (`filters`, `filterTagGroup` and friends), header sort (`unsortable` lists
  the columns without one, `defaultOrder`), pages of `GRID_PAGE_LIMITS`
  (25, 50, 100), the list's own empty state (`empty`, a module-level
  component), state kept in memory, and every popup portalled into the
  screen's themed root. Extra plugins (row select, row click, a second main
  view) and bridges go in as children.
- **`useLocalGridLoad(rows, options)`**: a `load` over rows already in memory,
  for a list read whole: `search` names the texts the search box matches,
  `filter` keeps a row under the other filters, `compare` sorts by column id.
  Render its `reloadBridge` inside the grid; a new `rows` array is a reload, so
  memoize it. `shownRows` and `pageOfRows` are the same rules as pure functions.
  A list the server pages writes its own `load`, as Specs does.
- **`createGridCells(name)`**: a context for what cells need beyond their row
  (callbacks, labels), so `columns` stays one array: the grid resets its
  column state on a new one.
- **Conventions**: column ids are snake_case (the kit throws otherwise); a
  name column is `NameCell` (an icon and a name that opens the row); a cell
  with nothing to show is `NoData`; `GridEmpty` says "nothing here yet" or
  "nothing matched"; a list that did not load is `GridFailed` with a retry;
  the line under a list is `GridFooter`.
- **Filters**: `TEXT_SEARCH_FILTER_KEY`, and `tagGroupChoice`, `listChoices`,
  `searchQuery` read what a stored filter holds, whatever shape it has.
- **Theme**: `useThemedRoot` finds the screen's `[data-theme]` root for a
  popup's `container`. A screen's root carries `data-theme` from
  `useHostChrome`; without it the kit's tokens stay light.

## Remembered choices

`useHostPreference('mfe.<name>')` reads and changes one of the person's UI
choices in `/me/ui-preferences` (the Kits screen's table or tiles). The shell
publishes the `mfe.` keys (`STUDIO_SHARED_PROPERTY_UI_PREFERENCES`) and writes
one when asked (`STUDIO_ACTION_PREFERENCE_SET`), so its store stays the
record's only writer. Declare both in the entry's `mfe.json`.
