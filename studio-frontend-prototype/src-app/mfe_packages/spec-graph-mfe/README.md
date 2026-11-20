# spec-graph-mfe

Project › Spec graph, the Spec graph kit's screen (`studio-backend/src/kit_registry/builtin/spec-graph.kit.json`).

The project's spec findings from the spec-graph service through `studio-spec-graph`:

- **Now**: `POST /cf/studio-spec-graph/v1/checks`, every deterministic finding at the project's branch;
- **Stored**: `GET /cf/studio-spec-graph/v1/findings`, what the project's runs stored in its graph (contradictions confirmed by the judges, with both passages).

Both are grouped by document. Each finding can be confirmed or dismissed (`POST …/findings/{fingerprint}/decision`): the decision is recorded in Project model's decision table, and a dismissed finding leaves checks and reviews. A project that is not set up gets a form for its documents (`PUT …/project`).

```
npm run build && npm run preview   # port 3380
npm run test:unit
```
