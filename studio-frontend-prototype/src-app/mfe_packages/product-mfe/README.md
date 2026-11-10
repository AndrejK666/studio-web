# product-mfe — Project › Product and Project › Components

The prototype's Product and Components project tabs, carried over (ADR-0069).
One entry, two extensions switched on the shell's `section`:

- **Product** (`/product`, kit `product-releases`) — the page of
  `product-sections-view.tsx`: header with the engine's verdict and the next
  action, what the product is, the strip from configured to running, the
  sources its revision pins, and its parts: Map, Infrastructure, Backend
  (the configurator and gear config), Frontend (the constructor), Parts.
- **Components** (`/project-components`, kit `components`) — the project's
  inventory (`project-components-view.tsx`).

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
`kits.tsx`). `product.gdl` text is still edited in the browser
(`infra-gdl.ts`, `infra-store.ts`, `product-map.ts#productGdlLines`); those
belong behind server routes that do not exist yet. See `docs/parity.md`.
