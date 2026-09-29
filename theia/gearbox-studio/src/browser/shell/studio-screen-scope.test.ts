// The screen scope Studio starts: inside the Gearbox perspective only, closing
// what belongs to a product that is no longer open, keeping the perspective's
// frame, and never folding a panel or opening Start.
import "reflect-metadata";

jest.mock("@theia/core/lib/browser", () => ({ ApplicationShell: class {} }));
jest.mock("@theia/core/lib/browser/frontend-application-state", () => ({ FrontendApplicationStateService: class {} }));
jest.mock("@theia/core/lib/browser/perspective-service", () => ({ PerspectiveService: class {} }));
jest.mock("../view-contributions", () => ({
  StartViewContribution: class {},
  ProductViewContribution: class {},
  GearAuthorViewContribution: class {},
}));
jest.mock("./studio-context-service", () => ({ StudioContextService: class {} }));

import { PERSPECTIVE_FRAME, StudioScreenScopeService, studioMayWithdraw } from "./studio-screen-scope";
import type { StudioContext } from "./studio-context-service";

interface FakeWidget {
  id: string;
  isAttached: boolean;
  ownerIdentity?: string;
}

function harness(perspective: string) {
  const service = new StudioScreenScopeService();
  let context: StudioContext = { kind: "product", product: { path: "/w/a/product.gdl", label: "a" } } as StudioContext;
  const closed: string[] = [];
  const collapsed: string[] = [];
  const opened: string[] = [];
  let changePerspective: () => void = () => undefined;
  const widgets: FakeWidget[] = [];
  const state = { perspective };
  Object.assign(service, {
    perspectives: {
      getActivePerspectiveId: () => state.perspective,
      onDidChangePerspective: (listener: () => void) => {
        changePerspective = listener;
        return { dispose: () => undefined };
      },
    },
    contexts: {
      get current() {
        return context;
      },
      settled: async () => undefined,
      onDidChange: () => ({ dispose: () => undefined }),
    },
    appState: { reachedState: () => new Promise(() => undefined) },
    shell: {
      get widgets() {
        return widgets.filter((w) => !closed.includes(w.id));
      },
      onDidAddWidget: () => ({ dispose: () => undefined }),
      onDidRemoveWidget: () => ({ dispose: () => undefined }),
      closeMany: async (doomed: FakeWidget[]) => {
        closed.push(...doomed.map((w) => w.id));
      },
      isExpanded: () => true,
      collapsePanel: async (area: string) => {
        collapsed.push(area);
      },
      expandPanel: (area: string) => collapsed.push(`expand:${area}`),
    },
    focus: { forget: () => undefined },
    start: { openView: async () => opened.push("start") },
    product: { openIfProduct: async () => opened.push("product") },
    gear: { openView: async () => opened.push("gear") },
  });
  service.onStart();
  return {
    service,
    widgets,
    closed,
    collapsed,
    opened,
    state,
    setContext: (next: StudioContext) => {
      context = next;
    },
    changePerspective: () => changePerspective(),
  };
}

const productA: StudioContext = { kind: "product", product: { path: "/w/a/product.gdl", label: "a" } } as StudioContext;
const productB: StudioContext = { kind: "product", product: { path: "/w/b/product.gdl", label: "b" } } as StudioContext;
const home: StudioContext = { kind: "home" } as StudioContext;

describe("the perspective's frame", () => {
  it("is the Product view and Conflicts, which Studio never withdraws", () => {
    expect(PERSPECTIVE_FRAME).toEqual(["gearbox.product", "gearbox.conflicts"]);
    expect(studioMayWithdraw("gearbox.product")).toBe(false);
    expect(studioMayWithdraw("gearbox.lock")).toBe(true);
    expect(studioMayWithdraw("explorer-view-container")).toBe(true);
  });
});

describe("Studio's screen scope", () => {
  async function settle(h: ReturnType<typeof harness>): Promise<void> {
    h.service.enqueue();
    await h.service.settled();
  }

  it("withdraws product A's Lock and Generate when product B opens, and keeps the frame", async () => {
    const h = harness("gearbox.product");
    h.setContext(productA);
    await settle(h);
    h.widgets.push(
      { id: "gearbox.product", isAttached: true, ownerIdentity: "product:file:///w/a/product.gdl" },
      { id: "gearbox.conflicts", isAttached: true },
      { id: "gearbox.lock", isAttached: true, ownerIdentity: "product:file:///w/a/product.gdl" },
      { id: "gearbox.generate", isAttached: true, ownerIdentity: "product:file:///w/a/product.gdl" },
      { id: "gearbox.catalogue", isAttached: true },
      { id: "terminal-1", isAttached: true },
    );
    h.setContext(productB);
    await settle(h);
    expect(h.closed.sort()).toEqual(["gearbox.generate", "gearbox.lock"]);
  });

  it("withdraws a closed product's screens on Home, and neither folds a panel nor opens Start", async () => {
    const h = harness("gearbox.product");
    h.setContext(productA);
    await settle(h);
    h.widgets.push(
      { id: "gearbox.product", isAttached: true },
      { id: "gearbox.lock", isAttached: true },
      { id: "gearbox.inspector", isAttached: true },
    );
    h.setContext(home);
    await settle(h);
    expect(h.closed).toEqual(["gearbox.lock"]);
    expect(h.collapsed).toEqual([]);
    expect(h.opened).not.toContain("start");
  });

  it("does nothing outside a Gearbox perspective, and catches up on the way in", async () => {
    const h = harness("studio.workbench");
    h.setContext(productA);
    h.widgets.push({ id: "gearbox.lock", isAttached: true, ownerIdentity: "product:file:///w/a/product.gdl" });
    h.setContext(productB);
    await settle(h);
    expect(h.closed).toEqual([]);
    expect(h.opened).toEqual([]);

    h.state.perspective = "gearbox.product";
    h.changePerspective();
    await h.service.settled();
    expect(h.closed).toEqual(["gearbox.lock"]);
  });
});
