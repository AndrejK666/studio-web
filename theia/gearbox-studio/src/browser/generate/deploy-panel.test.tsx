/**
 * @jest-environment jsdom
 */
// Deploy under Generate, for a kubernetes profile: what is offered in each state.
import "reflect-metadata";

import React from "@theia/core/shared/react";

import { DeployPanel, type DeployPanelProps } from "./deploy-panel";

interface Root {
  render(node: React.ReactNode): void;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("@theia/core/shared/react-dom/client") as { createRoot(host: Element): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act;

describe("the Deploy panel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  async function draw(over: Partial<DeployPanelProps>): Promise<void> {
    const props: DeployPanelProps = {
      generated: true,
      ready: true,
      images: [{ app: "api-gateway", image: "gbx-api-gateway:0.1.0" }],
      chart: "helm/shop",
      registry: undefined,
      namespace: "shop",
      docker: true,
      helm: "v4.2.3",
      environments: [],
      contexts: ["kind-local", "dev"],
      target: { kind: "context", name: "kind-local" },
      onTarget: () => undefined,
      onBuildImages: () => undefined,
      onPush: () => undefined,
      onTemplate: () => undefined,
      onDeploy: () => undefined,
      ...over,
    };
    await act(() => root.render(<DeployPanel {...props} />));
  }

  const q = (selector: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(selector);

  it("waits for Apply, then for the backend", async () => {
    await draw({ generated: false });
    expect(host.querySelector("[data-deploy-state=not-generated]")).not.toBeNull();
    await draw({ ready: undefined });
    expect(host.querySelector("[data-deploy-state=checking]")).not.toBeNull();
  });

  it("says the tree has nothing to deploy rather than offering buttons", async () => {
    await draw({ images: [], chart: undefined });
    expect(host.querySelector("[data-deploy-state=no-plan]")).not.toBeNull();
    expect(q("[data-deploy-install]")).toBeNull();
  });

  it("builds, previews and deploys into the chosen context, and pushes only with a registry", async () => {
    const onBuildImages = jest.fn();
    const onTemplate = jest.fn();
    const onDeploy = jest.fn();
    await draw({ onBuildImages, onTemplate, onDeploy });
    expect(q("[data-deploy-push]")?.disabled).toBe(true);
    expect(host.querySelector("[data-deploy-images]")?.textContent).toMatch(/stay in this machine's Docker/);
    await act(() => q("[data-deploy-build]")?.click());
    await act(() => q("[data-deploy-template]")?.click());
    await act(() => q("[data-deploy-install]")?.click());
    expect(onBuildImages).toHaveBeenCalled();
    expect(onTemplate).toHaveBeenCalled();
    expect(onDeploy).toHaveBeenCalled();

    const onPush = jest.fn();
    await draw({ registry: "ghcr.io/acme", onPush });
    expect(host.querySelector("[data-deploy-images]")?.textContent).toMatch(/pushed to ghcr.io\/acme/);
    await act(() => q("[data-deploy-push]")?.click());
    expect(onPush).toHaveBeenCalled();
  });

  it("says helm is missing and offers no Deploy without it", async () => {
    await draw({ helm: undefined });
    expect(host.querySelector("[data-deploy-missing=helm]")).not.toBeNull();
    expect(q("[data-deploy-install]")?.disabled).toBe(true);
    expect(q("[data-deploy-template]")?.disabled).toBe(true);
  });

  it("lists the organization's environments above the kube contexts and deploys there without helm", async () => {
    const onTarget = jest.fn();
    const onDeploy = jest.fn();
    const prod = { id: "e-prod", name: "prod", namespace: "shop-prod", registry: "ghcr.io/acme", protected: true };
    await draw({ environments: [prod], target: { kind: "environment", id: "e-prod" }, helm: undefined, registry: "ghcr.io/acme", onTarget, onDeploy });
    const groups = [...host.querySelectorAll("[data-deploy-target] optgroup")].map((g) => g.getAttribute("label"));
    expect(groups).toEqual(["The organization's environments", "Kube contexts on this machine"]);
    expect(host.querySelector("[data-deploy-environment=prod]")?.textContent).toMatch(/approves it first/);
    expect(host.querySelector("[data-deploy-missing=helm]")).toBeNull();
    expect(q("[data-deploy-install]")?.disabled).toBe(false);
    await act(() => q("[data-deploy-install]")?.click());
    expect(onDeploy).toHaveBeenCalled();

    const select = host.querySelector<HTMLSelectElement>("[data-deploy-target]");
    await act(() => {
      if (select) {
        select.value = "ctx:dev";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onTarget).toHaveBeenCalledWith({ kind: "context", name: "dev" });
  });

  it("says what the server answered, and does not ask twice at once", async () => {
    const prod = { id: "e-prod", name: "prod", namespace: "shop-prod", registry: "", protected: false };
    await draw({ environments: [prod], target: { kind: "environment", id: "e-prod" }, requesting: true, note: "queued" });
    expect(q("[data-deploy-install]")?.disabled).toBe(true);
    expect(host.querySelector("[data-deploy-note]")?.textContent).toBe("queued");
  });
});
