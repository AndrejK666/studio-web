/* The rollups' whole contract is "an unknown count is not a zero", and that is
 * a claim about failure paths, which is exactly what does not get exercised by
 * looking at a working screen. These tests drive the failures on purpose.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { api, TENANT_TYPES } from "./api";
import { projectRollup, rollupText, workspaceRollup } from "./rollups";

describe("rollupText", () => {
  it("renders a dash for unknown and the digits for a known count", () => {
    expect(rollupText(null)).toBe("—");
    expect(rollupText(3)).toBe("3");
  });

  it("renders a real zero as 0, not as unknown", () => {
    // A project with no documents is a fact worth stating; only a count that
    // could not be read is a dash.
    expect(rollupText(0)).toBe("0");
  });
});

describe("workspaceRollup", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("counts only child tenants of type project", async () => {
    vi.spyOn(api, "tenantChildren").mockResolvedValue({
      // The real GTS type ids, not "project"/"workspace" — a tenant_type is a
      // fully-qualified identifier, and a test that invents short ones passes
      // against a filter that would match nothing in production.
      items: [
        { id: "p1", name: "One", tenant_type: TENANT_TYPES.project },
        { id: "w1", name: "Nested workspace", tenant_type: TENANT_TYPES.workspace },
        { id: "p2", name: "Two", tenant_type: TENANT_TYPES.project },
      ],
    } as never);

    const { rollup, children } = await workspaceRollup("t", "ws");

    expect(rollup.projects).toBe(2);
    expect(children?.map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("reports unknown, not zero, when the tenant cannot be read", async () => {
    // A self-managed workspace answers 404 from outside its subtree. That is
    // isolation working; it is not "this workspace has no projects".
    vi.spyOn(api, "tenantChildren").mockRejectedValue(new Error("404"));

    const { rollup, children } = await workspaceRollup("t", "ws");

    expect(rollup.projects).toBeNull();
    expect(children).toBeNull();
  });

  it("reports a genuinely empty workspace as zero", async () => {
    vi.spyOn(api, "tenantChildren").mockResolvedValue({ items: [] } as never);
    expect((await workspaceRollup("t", "ws")).rollup.projects).toBe(0);
  });
});

describe("projectRollup", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("takes the document count from the page total, not the rows", async () => {
    // The caller asks for one row; believing `items.length` here would report
    // every project as having exactly one document.
    vi.spyOn(api, "docBindings").mockResolvedValue({ items: [{}], total: 42 } as never);
    vi.spyOn(api, "listArtifactNodes").mockResolvedValue({ nodes: [], total: 0 } as never);
    vi.spyOn(api, "workspaceSettings").mockResolvedValue({ repos: [] } as never);

    expect((await projectRollup("t", "ws", "p")).documents).toBe(42);
  });

  it("settles each count on its own — one dead gear costs one number", async () => {
    vi.spyOn(api, "docBindings").mockRejectedValue(new Error("no studio-documents"));
    vi.spyOn(api, "listArtifactNodes").mockResolvedValue({ nodes: [], total: 7 } as never);
    vi.spyOn(api, "workspaceSettings").mockResolvedValue({ repos: [{}, {}] } as never);

    const r = await projectRollup("t", "ws", "p");

    expect(r.documents).toBeNull();
    expect(r.findings).toBe(7);
    expect(r.repos).toBe(2);
  });

  it("treats a capped total (no count in the contract) as unknown", async () => {
    vi.spyOn(api, "docBindings").mockResolvedValue({ items: [], total: 0 } as never);
    vi.spyOn(api, "listArtifactNodes").mockResolvedValue({ nodes: [] } as never);
    vi.spyOn(api, "workspaceSettings").mockResolvedValue({ repos: [] } as never);

    expect((await projectRollup("t", "ws", "p")).findings).toBeNull();
  });

  it("distinguishes settings with no repos from settings that could not be read", async () => {
    vi.spyOn(api, "docBindings").mockResolvedValue({ items: [], total: 0 } as never);
    vi.spyOn(api, "listArtifactNodes").mockResolvedValue({ nodes: [], total: 0 } as never);

    vi.spyOn(api, "workspaceSettings").mockResolvedValue({} as never);
    expect((await projectRollup("t", "ws", "p")).repos).toBe(0);

    vi.spyOn(api, "workspaceSettings").mockResolvedValue(null as never);
    expect((await projectRollup("t", "ws", "p")).repos).toBeNull();

    vi.spyOn(api, "workspaceSettings").mockRejectedValue(new Error("boom"));
    expect((await projectRollup("t", "ws", "p")).repos).toBeNull();
  });
});
