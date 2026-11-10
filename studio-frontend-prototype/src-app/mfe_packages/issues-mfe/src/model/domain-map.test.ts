// Ported unchanged from the prototype: the "the model map" tests of src/domain-model-views.test.ts at 00828880
// (the "to resolve" ones pin the server's queue now: studio-backend/src/documents/spec_model/resolve_tests.rs).
import { describe, expect, it } from "vitest";

import { entityArea, layout, mapEdges, neighbours } from "./domain-map";
import { entitiesOf, type SpecModelFact } from "./spec-model";

const fact = (subject: string, kind: SpecModelFact["kind"], extra: Partial<SpecModelFact> = {}): SpecModelFact => ({
  kind,
  subject,
  aspect: "",
  value: "",
  text: `${subject} ${kind}`,
  status: "active",
  status_because: "",
  source: { path: "docs/design/a.md", line_start: 1, line_end: 1, quote: "q" },
  ...extra,
});

describe("the model map", () => {
  const entities = entitiesOf([
    fact("Project", "entity", { text: "A project belongs to a workspace." }),
    fact("Project", "relation", { aspect: "belongs to", value: "Workspace" }),
    fact("Workspace", "entity", { text: "A workspace groups projects." }),
    fact("Gear", "entity", { text: "A gear is built by its project." }),
    fact("Note", "entity", { text: "Nothing else." }),
  ]);

  it("draws a declared relation once, and a mention where one entity's facts name another", () => {
    const edges = mapEdges(entities);
    const of = (a: string, b: string) => edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
    expect(of("project", "workspace")?.kind).toBe("relation");
    expect(of("gear", "project")?.kind).toBe("mentions");
    expect(of("note", "project")).toBeUndefined();
    expect([...neighbours("project", edges)].sort()).toEqual(["gear", "workspace"]);
  });

  it("places every node inside the frame, the same way every time", () => {
    const keys = entities.map((e) => e.key);
    const edges = mapEdges(entities);
    const a = layout(keys, edges, 400, 300);
    expect(a).toEqual(layout(keys, edges, 400, 300));
    for (const p of a) {
      expect(p.x).toBeGreaterThanOrEqual(12);
      expect(p.x).toBeLessThanOrEqual(388);
      expect(p.y).toBeGreaterThanOrEqual(12);
      expect(p.y).toBeLessThanOrEqual(288);
    }
  });

  it("groups an entity by the folder most of its facts come from", () => {
    expect(entityArea({ facts: [fact("x", "entity"), fact("x", "lifecycle"), fact("x", "attribute", { source: { path: "PRODUCT.md" } })] })).toBe("docs/design");
  });
});
