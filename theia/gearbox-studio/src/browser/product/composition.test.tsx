/**
 * @jest-environment jsdom
 */
// The Composition tree: one plugin can be removed from beside it, without
// taking its host and the host's other plugins along. The host is expanded:
// a host's plugins start folded (Gearbox Studio's composition list).
import "reflect-metadata";

jest.mock("../reveal-link", () => ({ RevealLink: () => null }));

import React from "@theia/core/shared/react";

import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { ProductState } from "../product-store";
import type { RevealService } from "../reveal-service";
import { Composition } from "./composition";

interface Root {
  render(node: React.ReactNode): void;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("@theia/core/shared/react-dom/client") as { createRoot(host: Element): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act;

const state = {
  open: { path: "/w/product.gdl", label: "product.gdl" },
  profile: "local",
  intent: {
    selected_gears: [
      {
        gear: "authn-resolver",
        plugins: [
          { gear: "oidc-authn-plugin", entry_index: 0 },
          { gear: "static-authn-plugin", entry_index: 1 },
        ],
      },
    ],
  },
} as unknown as ProductState;

describe("the Composition tree", () => {
  let host: HTMLDivElement;
  let root: Root;
  const remove = jest.fn();

  beforeEach(async () => {
    remove.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(
        <Composition
          state={state}
          descriptors={[]}
          selection={undefined}
          select={() => undefined}
          add={() => undefined}
          remove={remove}
          settings={null}
          reveals={{} as RevealService}
          expanded={new Set(["authn-resolver"])}
          create={() => undefined}
          toggleFold={() => undefined}
        />,
      ),
    );
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  it("removes one plugin from beside it, and only that entry", async () => {
    const button = host.querySelector<HTMLButtonElement>('[data-remove-plugin="authn-resolver:0"]');
    expect(button?.getAttribute("aria-label")).toBe("Remove oidc-authn-plugin from authn-resolver");
    await act(() => button?.click());
    expect(remove).toHaveBeenCalledWith("authn-resolver", 0);
  });

  it("counts a host's plugins on its row", () => {
    const row = host.querySelector('[data-composition-gear="authn-resolver"]');
    expect(row?.querySelector(".gbx-count-chip")?.getAttribute("aria-label")).toBe("2 plugins");
  });

  it("says on the host's Remove that it takes the plugins too", () => {
    const hostRemove = host.querySelector<HTMLButtonElement>('[aria-label="Remove authn-resolver from product"]');
    expect(hostRemove?.title).toMatch(/and its plugins \(oidc-authn-plugin, static-authn-plugin\)/);
  });
});

describe("a Composition row", () => {
  let host: HTMLDivElement;
  let root: Root;

  const withResolution = {
    ...state,
    diagnostics: [
      { code: "GBX0001", severity: "warning", message: "m", subject: "gear:authn-resolver" },
      { code: "GBX0002", severity: "error", message: "m", subject: "gear:types-registry" },
    ],
    resolution: {
      product: {
        gears: {
          "authn-resolver": { selected_by: [{ reason: "selected" }] },
          "types-registry": { selected_by: [{ reason: "colocated_by", gear: "authn-resolver" }] },
        },
      },
    },
  } as unknown as ProductState;
  const descriptors = [
    { id: "authn-resolver", display_name: "AuthN resolver", description: "Resolves who is calling." },
  ] as unknown as GearDescriptor[];

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(
        <Composition
          state={withResolution}
          descriptors={descriptors}
          selection={undefined}
          select={() => undefined}
          add={() => undefined}
          remove={() => undefined}
          settings={null}
          reveals={{} as RevealService}
          expanded={new Set()}
          create={() => undefined}
          toggleFold={() => undefined}
        />,
      ),
    );
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  it("reads in two lines: the name, then the description", () => {
    const row = host.querySelector('[data-composition-gear="authn-resolver"]');
    expect(row?.querySelector(".gbx-gear-row-name")?.textContent).toBe("AuthN resolver");
    expect(row?.querySelector(".gbx-gear-row-line")?.textContent).toBe("Resolves who is calling.");
  });

  it("marks the worst diagnostic about the gear with a dot", () => {
    expect(host.querySelector('[data-composition-gear="authn-resolver"] [data-gear-health]')?.getAttribute("data-gear-health")).toBe("warning");
    expect(host.querySelector('[data-pulled-in="types-registry"] [data-gear-health]')?.getAttribute("data-gear-health")).toBe("error");
  });

  it("lists the pulled-in gears as a captioned group, each saying who requires it", () => {
    const group = host.querySelector(".gbx-composition-automatic");
    expect(group?.querySelector(".gbx-group-caption")?.textContent).toBe("Automatically included (1)");
    expect(group?.querySelector('[data-pulled-in="types-registry"] .gbx-gear-row-line')?.textContent).toBe("Required by authn-resolver");
  });
});
