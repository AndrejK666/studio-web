# product-mfe — Project › Product and Project › Components

The prototype's Product and Components project tabs, carried over (ADR-0069).
One entry, two extensions switched on the shell's `section`:

- **Product** (`/product`, kit `project-product`) — the page of
  `product-sections-view.tsx`: header with the engine's verdict and the next
  action, what the product is, the strip from configured to running, the
  sources its revision pins, and its parts: Map, Infrastructure, Backend
  (the configurator and gear config), Frontend (the constructor), Parts.
- **Components** (`/project-components`, kit `components`) — the project's
  inventory (`project-components-view.tsx`).

Product also says how the product is assembled (ADR-0072,
`src/screens/product/assembly/`): the strategy it uses (`spec_mapping` or
`gears_matcher`), where that comes from, the project's choice, and "Propose
gears", which goes through the engine's completion and the person's
confirmation.

A second entry (`./gearsMatcherLifecycle`, `GearsMatcherRoot.tsx`) is the
Gears matcher kit's (`gears-matcher`, opt-in), shown only where it is
installed:

- **Gear match** (`/gear-match`, project) — what the gears-matcher service
  read in the specs (`src/screens/product/match/`); it was a section of
  Product.
- **Gears matcher** (`/gears-matcher`, organization) — the service's state
  and the organization's default strategy (`src/screens/matcher/`).

Layout:

- `src/model/` — the prototype's pure modules, unchanged but for import
  paths, each with its test suite (`product*.ts`, `frontend-constructor.ts`,
  `infra-*.ts`, `spec-coverage.ts`, `project-inventory.ts`, …).
- `src/api/types.ts` — the wire shapes, copied from the prototype's client.
- `src/api/ProductApiService.ts` — the reads and writes, one descriptor each.
- `src/api/client.ts` — the prototype's call signatures over the service
  (`api`, bearer argument ignored, for the models that call it; `productApi`
  without it, for the screens). Writes to the product record fire
  `studio:product-changed` as the prototype's did.
- `src/screens/product/<part>/` — each part of the page with its own
  dictionary; `src/screens/components/` — the inventory.

Not carried over: the Backend slot's IDE kits journey (`ProjectKits` from
`kits.tsx`). See `docs/parity.md`.

On the server, not here: `product.gdl` is read and edited by studio-product
(`GET`/`PUT /studio-product/v1/product-infra` for the infra services,
`POST /product-description-edits` for structured edits,
`POST /product-description-outlines` for which lines say which node and the
declared profiles), and so is the product-kind proposal
(`GET`/`PUT /studio-product/v1/product-kind`). The prototype's `infra-gdl.ts`
and the rules of `product-kind.ts` moved there with their tests;
`infra-store.ts`, `product-kind.ts` and `product-map.ts#productGdlLines` here
only call those routes or draw what they answer.
