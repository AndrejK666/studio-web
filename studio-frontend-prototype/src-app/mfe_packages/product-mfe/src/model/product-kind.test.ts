// Ported unchanged from the prototype (src/product-kind.test.ts at 00828880); only the import paths changed.
// The prototype's last block here tested project-path.ts (the Overview's path, not this kit's): left with it.
import { describe, expect, it } from "vitest";
import { kindStatus, proposeKind, readKindChoice, withKind, type KindFacts } from "./product-kind";

const EMPTY: KindFacts = {
  brief: null,
  capabilities: [],
  requirements: [],
  ownComponents: { gears: 0, frontx: 0, services: 0 },
  product: { gears: 0, frontend: false },
};

describe("proposeKind", () => {
  it("proposes a full product on gears, and says why, when the specs say nothing", () => {
    const p = proposeKind(EMPTY);
    expect(p.kind).toBe("gear_product");
    expect(p.basis).toBe("none");
    expect(p.reasons[0]).toMatch(/too little/);
    expect(p.alternatives).toHaveLength(3);
  });

  it("reads screens and services in the brief as a full product", () => {
    const p = proposeKind({ ...EMPTY, brief: "A dashboard where tenants see their invoices, over a REST API." });
    expect(p.kind).toBe("gear_product");
    expect(p.basis).toBe("specs");
    expect(p.reasons.join(" ")).toMatch(/“dashboard”/);
  });

  it("reads services and no screens as a gear service", () => {
    const p = proposeKind({
      ...EMPTY,
      brief: "A billing service: an API and webhooks for payment events.",
      capabilities: [{ key: "billing.invoices", from: ["PRD"] }],
    });
    expect(p.kind).toBe("gear_service");
  });

  it("reads screens over nothing of its own as a FrontX app", () => {
    const p = proposeKind({ ...EMPTY, brief: "A portal with screens for the help desk.", capabilities: null });
    expect(p.kind).toBe("frontx_app");
    expect(p.reasons.join(" ")).toMatch(/Could not read the declared capabilities/);
  });

  it("reads own services without gears as built from its own source", () => {
    const p = proposeKind({
      ...EMPTY,
      brief: "Our existing application, a Spring monolith with its own Dockerfile.",
      ownComponents: { gears: 0, frontx: 0, services: 2 },
    });
    expect(p.kind).toBe("source_built");
    expect(p.reasons.join(" ")).toMatch(/service\.gdl/);
  });

  it("lets gears in the repositories outweigh a Dockerfile", () => {
    const p = proposeKind({
      ...EMPTY,
      brief: "Screens and APIs; a Dockerfile for local runs.",
      ownComponents: { gears: 4, frontx: 2, services: 0 },
    });
    expect(p.kind).toBe("gear_product");
    expect(p.basis).toBe("specs");
  });

  it("counts the product as configured", () => {
    const p = proposeKind({ ...EMPTY, product: { gears: 3, frontend: true } });
    expect(p.kind).toBe("gear_product");
    expect(p.basis).toBe("sources");
  });
});

describe("the choice", () => {
  it("reads only a known kind", () => {
    expect(readKindChoice({ kind: "frontx_app", confirmed_at: "x" })?.kind).toBe("frontx_app");
    expect(readKindChoice({ kind: "recipe" })).toBeNull();
    expect(readKindChoice(null)).toBeNull();
  });

  it("is written beside the rest of the configuration", () => {
    const cfg = withKind({ brief: "b" }, "gear_service", "gear_product", null, new Date("2026-11-04T00:00:00Z"));
    expect(cfg).toEqual({
      brief: "b",
      product_kind: { kind: "gear_service", proposed: "gear_product", confirmed_by: null, confirmed_at: "2026-11-04T00:00:00.000Z" },
    });
  });

  it("says a confirmed kind and what Studio had proposed", () => {
    const s = kindStatus({ kind: "gear_service", proposed: "gear_product", confirmed_at: "" }, null);
    expect(s.done).toBe(true);
    expect(s.text).toMatch(/Gear service, confirmed \(Studio proposed Full product on gears\)/);
    expect(kindStatus(null, proposeKind(EMPTY)).done).toBe(false);
  });
});

