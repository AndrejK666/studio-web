// Constructor Studio: what Building's start page says, as plain functions --
// tested in building-start-model.test.ts; building-start-page.ts reads and
// registers.
//
// The page is the Product view's empty state brought to the empty dock: the
// same lists (`emptyStateLists` -- a product shows once, the workspace's before
// the remembered), the same words for a workspace with none, and the catalogue's
// size, which the empty state does not show. Nothing new is computed here.

import type { CatalogueState, ProductRef } from "../../common/protocol";
import type { EmptyStateLists } from "../product/product-empty-state";

export interface ProductRowData {
  readonly name: string;
  readonly folder: string;
  readonly tag?: string;
  readonly title: string;
  readonly ref: ProductRef;
  readonly kind: "workspace" | "recent";
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface SectionData<R> {
  readonly id: string;
  readonly title: string;
  readonly count?: string;
  readonly rows: readonly R[];
  readonly empty?: string;
  readonly note?: string;
}

export interface CatalogueRowData {
  readonly name: string;
  readonly detail: string;
}

const ENGINE_DOWN = "the Gearbox engine is not running";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function productRows(
  refs: readonly ProductRef[],
  kind: "workspace" | "recent",
  last: ProductRef | undefined,
  engineConnected: boolean,
): ProductRowData[] {
  return refs.map((ref) => ({
    name: ref.label,
    folder: ref.path,
    tag: last !== undefined && last.path === ref.path ? "last opened" : undefined,
    title: ref.path,
    ref,
    kind,
    enabled: engineConnected,
    reason: engineConnected ? undefined : ENGINE_DOWN,
  }));
}

/** The workspace's products and the remembered ones, as two sections. */
export function productSections(
  lists: EmptyStateLists,
  engineConnected: boolean,
  engineReason: string,
): { workspace: SectionData<ProductRowData>; recent: SectionData<ProductRowData> } {
  const nothing = lists.workspace.length === 0 && lists.recent.length === 0;
  return {
    workspace: {
      id: "building.products",
      title: "Products in this workspace",
      count: lists.workspace.length ? plural(lists.workspace.length, "product", "products") : undefined,
      rows: productRows(lists.workspace, "workspace", lists.last, engineConnected),
      // The Product view's own words (product-empty-state.tsx).
      empty: nothing
        ? "This workspace has no product yet: no product.gdl at product.gdl or products/<name>/product.gdl, " +
          "in the opened folder or in any checkout directly under it. Create one from gears, or open a product description."
        : "None in this folder; the recent ones are elsewhere.",
      note: engineConnected
        ? undefined
        : `The Gearbox engine is not running${engineReason ? `: ${engineReason}` : ""}. Products open once it is.`,
    },
    recent: {
      id: "building.recent",
      title: "Recent",
      rows: productRows(lists.recent, "recent", lists.last, engineConnected),
      empty: "No product opened from elsewhere yet.",
    },
  };
}

/** The catalogue's size, and where its gears come from; one row, or why there is none. */
export function catalogueSection(state: CatalogueState): SectionData<CatalogueRowData> {
  const base = { id: "building.catalogue", title: "Catalogue" };
  if (state.status === "loading" && state.rows.length === 0) {
    return { ...base, rows: [], empty: "Reading the catalogue…" };
  }
  if (state.status === "error") {
    return { ...base, rows: [], empty: `The catalogue could not be read: ${state.error ?? "unknown error"}` };
  }
  if (state.rows.length === 0) {
    return {
      ...base,
      rows: [],
      empty: state.unavailable
        ? `No corpus in this workspace, and the Studio's could not be asked: ${state.unavailable}`
        : state.status === "idle"
          ? "The catalogue has not been read yet."
          : "No gear in this workspace's corpus.",
    };
  }
  const failed = state.failedRoots.length;
  return {
    ...base,
    rows: [
      {
        name: plural(state.rows.length, "gear", "gears"),
        detail: state.remote ? `From ${state.remote}, the Studio's corpus` : "In this workspace's corpus",
      },
    ],
    note: failed ? `${plural(failed, "source", "sources")} could not be opened.` : undefined,
  };
}
