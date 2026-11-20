# mna-mfe — the M&A due diligence kit

Project › Deal: the screen of the built-in `mna` kit. A deal is a project of
the kit's project type (ADR-0073), so the tab shows only on projects where the
kit is installed (`presentation.kit` in `mfe.json`).

- `src/api/MnaApiService.ts` — every read and write, all on
  `studio-kits` under `/mna/*?project_id=`: the deal, its evidence, findings,
  risks and open questions.
- `src/model/deal.ts` — the pure parts: the evidence's groups and how a fact
  reads, the deal edit patch, badge tones, who signed off.
- `src/screens/deal/` — the screen: header, recommendation and sign-off,
  thesis, evidence, and the three lists on the shared `ListGrid`.

Every number on the evidence says where it came from (`source`), and a fact
the server could not read says why instead of showing a number.
