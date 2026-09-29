/**
 * @jest-environment jsdom
 */
// Build and Run under Generate: what is offered in each state.
import "reflect-metadata";

import React from "@theia/core/shared/react";

import type { RunTarget } from "../../common/run-product";
import { RunPanel, type RunPanelProps } from "./run-panel";

interface Root {
  render(node: React.ReactNode): void;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("@theia/core/shared/react-dom/client") as { createRoot(host: Element): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act;

const shop: RunTarget = {
  app: "shop",
  bin: "gbx-shop",
  config: "config/shop.yaml",
  localConfig: "config/shop.local.yaml",
  dbGears: ["bss-pricing", "types-registry"],
  address: "127.0.0.1:8087",
};

describe("the Build and Run panel", () => {
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

  async function draw(over: Partial<RunPanelProps>): Promise<void> {
    const props: RunPanelProps = {
      generated: true,
      verdict: { ready: true },
      targets: [shop],
      chosen: shop,
      postgres: "answers",
      docker: true,
      startingPostgres: false,
      onChoose: () => undefined,
      onBuild: () => undefined,
      onRun: () => undefined,
      onLinkedGears: () => undefined,
      onStartPostgres: () => undefined,
      onOpen: () => undefined,
      ...over,
    };
    await act(() => root.render(<RunPanel {...props} />));
  }

  const q = (selector: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(selector);

  it("waits for Apply before offering anything", async () => {
    await draw({ generated: false });
    expect(host.querySelector("[data-run-state=not-generated]")).not.toBeNull();
    expect(q("[data-run-build]")).toBeNull();
  });

  it("says cargo is missing, with the link, and offers no Build or Run", async () => {
    await draw({ verdict: { ready: false, reason: "Build and Run need Rust's cargo", help: { label: "rustup.rs", url: "https://rustup.rs" } } });
    expect(host.querySelector("[data-run-state=no-toolchain]")?.textContent).toContain("cargo");
    expect(host.querySelector<HTMLAnchorElement>("a")?.href).toBe("https://rustup.rs/");
    expect(q("[data-run-build]")).toBeNull();
    expect(q("[data-run-run]")).toBeNull();
  });

  it("runs Build, Run and the linked-gears check, and opens the address", async () => {
    const onBuild = jest.fn();
    const onRun = jest.fn();
    const onLinkedGears = jest.fn();
    const onOpen = jest.fn();
    await draw({ onBuild, onRun, onLinkedGears, onOpen });
    await act(() => q("[data-run-build]")?.click());
    await act(() => q("[data-run-run]")?.click());
    await act(() => q("[data-run-linked]")?.click());
    await act(() => q("[data-run-open]")?.click());
    expect(onBuild).toHaveBeenCalled();
    expect(onRun).toHaveBeenCalled();
    expect(onLinkedGears).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith("http://127.0.0.1:8087");
    expect(host.querySelector("[data-run-address]")?.textContent).toContain("http://127.0.0.1:8087");
  });

  it("says which gears need a database and which configuration Run uses", async () => {
    await draw({});
    const note = host.querySelector("[data-run-db]")?.textContent ?? "";
    expect(note).toContain("bss-pricing, types-registry need a database");
    expect(note).toContain("config/shop.local.yaml");
    expect(note).toContain("GEARS_PG_PASSWORD");
    expect(note).toContain("bss_pricing, types_registry");
  });

  it("offers to start a local Postgres only when nothing answers and docker is there", async () => {
    const onStartPostgres = jest.fn();
    await draw({ postgres: "none", onStartPostgres });
    await act(() => q("[data-run-start-postgres]")?.click());
    expect(onStartPostgres).toHaveBeenCalled();

    await draw({ postgres: "answers" });
    expect(q("[data-run-start-postgres]")).toBeNull();

    await draw({ postgres: "none", docker: false });
    expect(q("[data-run-start-postgres]")).toBeNull();
    expect(host.querySelector("[data-run-db-state=no-docker]")).not.toBeNull();
  });

  it("says nothing about a database for a product that needs none", async () => {
    await draw({ targets: [{ ...shop, dbGears: [] }], chosen: { ...shop, dbGears: [] } });
    expect(host.querySelector("[data-run-db]")).toBeNull();
  });

  it("lets a member choose among several host applications", async () => {
    const onChoose = jest.fn();
    const other = { ...shop, app: "admin", bin: "gbx-admin" };
    await draw({ targets: [shop, other], onChoose });
    const select = host.querySelector<HTMLSelectElement>("[data-run-app]");
    expect(select).not.toBeNull();
    await act(() => {
      if (select === null) return;
      select.value = "admin";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith("admin");
  });
});
