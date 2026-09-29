/**
 * @jest-environment jsdom
 */
// The Product view with no product: New, Open, the workspace's products and
// Recent -- what Building shows instead of the Start screen.
import "reflect-metadata";

import React from "@theia/core/shared/react";
// react-dom's client ships no typings in this tree (no @types/react-dom), so the
// two calls used here are typed by hand.
interface Root {
  render(node: React.ReactNode): void;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("@theia/core/shared/react-dom/client") as { createRoot(host: Element): Root };

import type { ProductRef } from "../../common/protocol";
import { ProductEmptyState, emptyStateLists, type ProductEmptyStateProps, type RecentProduct } from "./product-empty-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act;

const payments: ProductRef = { path: "/w/products/payments/product.gdl", label: "products/payments/product.gdl" };
const chat: ProductRef = { path: "/w/products/chat/product.gdl", label: "products/chat/product.gdl" };
const elsewhere: RecentProduct = { path: "/other/checkout/product.gdl", label: "other", openedAt: 1 };

describe("the empty state's lists", () => {
  it("lists a remembered product once, under the workspace when discovery found it too", () => {
    const lists = emptyStateLists([payments, chat], [{ ...chat, openedAt: 2 }, elsewhere]);
    expect(lists.workspace).toEqual([payments, chat]);
    expect(lists.recent.map((r) => r.path)).toEqual([elsewhere.path]);
  });

  it("offers to continue the last product opened, whichever list it is in", () => {
    expect(emptyStateLists([payments, chat], [{ ...chat, openedAt: 2 }, elsewhere]).last?.path).toBe(chat.path);
    expect(emptyStateLists([], []).last).toBeUndefined();
  });

  it("matches a Windows path however each side spells it", () => {
    const found: ProductRef = { path: "C:\\Users\\a\\p\\product.gdl", label: "p" };
    const remembered: RecentProduct = { path: "c:/Users/a/p/product.gdl", label: "p" };
    expect(emptyStateLists([found], [remembered]).recent).toEqual([]);
  });

  it("keeps POSIX paths case-sensitive", () => {
    const found: ProductRef = { path: "/w/P/product.gdl", label: "P" };
    const remembered: RecentProduct = { path: "/w/p/product.gdl", label: "p" };
    expect(emptyStateLists([found], [remembered]).recent).toEqual([remembered]);
  });
});

describe("the empty state, drawn", () => {
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

  async function draw(found: ProductRef[], remembered: RecentProduct[], over: Partial<ProductEmptyStateProps> = {}): Promise<void> {
    const props: ProductEmptyStateProps = {
      lists: emptyStateLists(found, remembered),
      engineConnected: true,
      onNew: () => undefined,
      onOpen: () => undefined,
      onOpenWorkspace: () => undefined,
      onOpenRecent: () => undefined,
      ...over,
    };
    await act(() => root.render(<ProductEmptyState {...props} />));
  }

  const q = (selector: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(selector);

  it("offers New and Open with nothing anywhere, and says why the list is empty", async () => {
    const onNew = jest.fn();
    const onOpen = jest.fn();
    await draw([], [], { onNew, onOpen });
    expect(host.textContent).toMatch(/no product yet/);
    expect(q("[data-product-empty-action=continue]")).toBeNull();
    await act(() => q("[data-product-empty-action=new]")?.click());
    await act(() => q("[data-product-empty-action=open]")?.click());
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("draws Recent, and opens a recent product through the recent path", async () => {
    const onOpenRecent = jest.fn();
    const onOpenWorkspace = jest.fn();
    await draw([payments], [elsewhere], { onOpenRecent, onOpenWorkspace });
    expect(host.querySelector("[data-product-empty-list=recent]")?.textContent).toContain("other");
    expect(host.textContent).not.toMatch(/no product yet/);
    await act(() => q(`[data-product-empty-list=recent] [data-product-empty-product='${elsewhere.path}']`)?.click());
    expect(onOpenRecent).toHaveBeenCalledWith({ path: elsewhere.path, label: elsewhere.label });
    await act(() => q(`[data-product-empty-list=workspace] [data-product-empty-product='${payments.path}']`)?.click());
    expect(onOpenWorkspace).toHaveBeenCalledWith(payments);
  });

  it("continues the last product in one press", async () => {
    const onOpenRecent = jest.fn();
    await draw([], [elsewhere], { onOpenRecent });
    const continueButton = q("[data-product-empty-action=continue]");
    expect(continueButton?.textContent).toBe("Continue other");
    await act(() => continueButton?.click());
    expect(onOpenRecent).toHaveBeenCalledWith(elsewhere);
  });

  it("holds New and Continue while the engine is down, and keeps Open", async () => {
    await draw([], [elsewhere], { engineConnected: false });
    expect(q("[data-product-empty-action=new]")?.disabled).toBe(true);
    expect(q("[data-product-empty-action=continue]")?.disabled).toBe(true);
    expect(q("[data-product-empty-action=open]")?.disabled).toBe(false);
  });
});
