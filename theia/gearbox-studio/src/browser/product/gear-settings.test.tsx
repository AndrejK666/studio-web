/**
 * @jest-environment jsdom
 */
// A gear's settings: features as switches with a count, configuration with its
// scope said once, and the escape hatches folded into one Advanced.
import "reflect-metadata";

jest.mock("@theia/core/lib/browser", () => ({ ConfirmDialog: class {} }));
jest.mock("@theia/monaco/lib/browser/monaco-text-model-service", () => ({ MonacoTextModelService: class {} }));
jest.mock("../shell/unsaved", () => ({ hasUnsavedEdits: () => false }));
jest.mock("../product-store", () => ({ ProductStore: class {} }));
jest.mock("../catalogue-store", () => ({ CatalogueStore: class {} }));
jest.mock("../shell/product-session-service", () => ({ ProductSessionService: class {} }));
jest.mock("../shell/engine-connection-service", () => ({ EngineConnectionService: class {} }));
jest.mock("../shell/studio-context-service", () => ({ StudioContextService: class {} }));

import React from "@theia/core/shared/react";

import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { GearSelection } from "../../common/generated/GearSelection";
import type { ProductEdit } from "../../common/generated/ProductEdit";
import type { ProductEditService } from "../product-edit-service";
import { GearSettings } from "./gear-settings";

interface Root {
  render(node: React.ReactNode): void;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("@theia/core/shared/react-dom/client") as { createRoot(host: Element): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act;

describe("a gear's settings", () => {
  let host: HTMLDivElement;
  let root: Root;
  const queued: ProductEdit[] = [];

  const edits = {
    draftConfig: (_gear: string, saved: Record<string, string>) => saved,
    draftConfigValues: (_gear: string, saved: Record<string, string>) => saved,
    draftFeatures: (_gear: string, saved: string[]) => saved,
    isDraftedFeatures: () => false,
    isDraftedConfig: () => false,
    queueDraft: (edit: ProductEdit) => {
      queued.push(edit);
      return true;
    },
  } as unknown as ProductEditService;

  const descriptor = {
    id: "studio",
    available_features: ["theia-bridge", "metrics", "k8s-auth"],
  } as unknown as GearDescriptor;
  const picked = { gear: "studio", features: ["metrics"] } as unknown as GearSelection;

  beforeEach(async () => {
    queued.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(
        <GearSettings
          descriptor={descriptor}
          picked={picked}
          edits={edits}
          sources={{} as never}
          viewingProfile="local"
        />,
      ),
    );
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  it("draws each feature as a switch, named in words, with its id beside it", () => {
    const option = host.querySelector('[data-feature-option="theia-bridge"]');
    expect(option?.querySelector(".gbx-feature-label")?.textContent).toBe("Theia bridge");
    expect(option?.querySelector(".gbx-feature-id")?.textContent).toBe("theia-bridge");
    const toggle = option?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.getAttribute("role")).toBe("switch");
    expect(toggle?.checked).toBe(false);
  });

  it("says how many are on, and a switch queues the feature list", async () => {
    expect(host.querySelector("[data-gear-features] .gbx-block-caption")?.textContent).toBe("Features · 1 of 3 on");
    await act(() => host.querySelector<HTMLInputElement>('[data-feature-option="theia-bridge"] input')?.click());
    expect(queued).toEqual([{ kind: "set_features", gear: "studio", features: ["metrics", "theia-bridge"] }]);
  });

  it("says once that configuration applies to every profile", () => {
    expect(host.querySelector("[data-settings-scope]")?.textContent).toBe("Applies to all profiles, not only local.");
  });

  it("folds the free keys and the free feature name into one Advanced", () => {
    const advanced = host.querySelector<HTMLDetailsElement>("details[data-inspector-advanced]");
    expect(advanced?.open).toBe(false);
    expect(advanced?.querySelector("summary")?.textContent).toBe("Advanced");
    expect(advanced?.querySelector("[data-config-new-key]")).not.toBeNull();
    expect(advanced?.querySelector("[data-feature-new]")).not.toBeNull();
  });
});
