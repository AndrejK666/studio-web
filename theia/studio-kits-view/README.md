# studio-kits-view

Studio kits in the desktop's Extensions view: the kits the open project has,
the rest of the catalogue, and search (`@kit`). Install puts a kit into the
checkout open in the window through the desktop backend
(`studio/src/node/desktop-kits.ts`), which runs `cfs` and reports the result to
the Studio.

A dependency of `electron-app` only: a browser session has no Extensions view.
See `docs/desktop-studio.md`, *Studio kits in the Extensions view*.
