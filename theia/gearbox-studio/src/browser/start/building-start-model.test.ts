import type { CatalogueState, Row } from "../../common/protocol";
import { emptyStateLists } from "../product/product-empty-state";
import { catalogueSection, productSections } from "./building-start-model";

const shop = { path: "C:/ws/products/shop/product.gdl", label: "shop" };
const blog = { path: "C:/other/blog/product.gdl", label: "blog" };

function catalogue(extra: Partial<CatalogueState>): CatalogueState {
  return { status: "ready", rows: [], diagnostics: [], failedRoots: [], error: undefined, total: 0, completed: 0, ...extra };
}

const gearRows = (n: number): Row[] => Array.from({ length: n }, () => ({ kind: "pending" }) as unknown as Row);

describe("Building's start page", () => {
  it("lists the workspace's products and the remembered ones, each once, marking the last opened", () => {
    const lists = emptyStateLists([shop], [{ ...shop, openedAt: 2 }, { ...blog, openedAt: 1 }]);
    const { workspace, recent } = productSections(lists, true, "");
    expect(workspace.rows.map((r) => r.name)).toEqual(["shop"]);
    expect(workspace.rows[0]?.tag).toBe("last opened");
    expect(workspace.count).toBe("1 product");
    expect(recent.rows.map((r) => [r.name, r.kind])).toEqual([["blog", "recent"]]);
    expect(workspace.note).toBeUndefined();
  });

  it("says in the Product view's words that a workspace has no product", () => {
    const { workspace, recent } = productSections(emptyStateLists([], []), true, "");
    expect(workspace.rows).toEqual([]);
    expect(workspace.empty).toMatch(/no product\.gdl at product\.gdl or products\/<name>\/product\.gdl/);
    expect(recent.empty).toBeTruthy();
  });

  it("with the engine down, the products are drawn disabled and the page says why", () => {
    const { workspace } = productSections(emptyStateLists([shop], []), false, "exited with code 1");
    expect(workspace.rows[0]?.enabled).toBe(false);
    expect(workspace.rows[0]?.reason).toBe("the Gearbox engine is not running");
    expect(workspace.note).toBe("The Gearbox engine is not running: exited with code 1. Products open once it is.");
  });

  it("gives the catalogue's size and where it comes from", () => {
    expect(catalogueSection(catalogue({ rows: gearRows(12) })).rows).toEqual([
      { name: "12 gears", detail: "In this workspace's corpus" },
    ]);
    expect(catalogueSection(catalogue({ rows: gearRows(1), remote: "acme/corpus@main" })).rows[0]).toEqual({
      name: "1 gear",
      detail: "From acme/corpus@main, the Studio's corpus",
    });
    expect(catalogueSection(catalogue({ rows: gearRows(3), failedRoots: [{} as never] })).note).toBe("1 source could not be opened.");
  });

  it("tells reading, failing, signed out and empty apart", () => {
    expect(catalogueSection(catalogue({ status: "loading" })).empty).toBe("Reading the catalogue…");
    expect(catalogueSection(catalogue({ status: "error", error: "boom" })).empty).toBe("The catalogue could not be read: boom");
    expect(catalogueSection(catalogue({ unavailable: "signed out" })).empty).toMatch(/could not be asked: signed out/);
    expect(catalogueSection(catalogue({})).empty).toBe("No gear in this workspace's corpus.");
    expect(catalogueSection(catalogue({ status: "idle" })).empty).toBe("The catalogue has not been read yet.");
  });
});
