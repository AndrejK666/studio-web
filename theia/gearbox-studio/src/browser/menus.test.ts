import "reflect-metadata";

import { MAIN_MENU_BAR } from "@theia/core/lib/common/menu";
import type { MenuModelRegistry, MenuPath } from "@theia/core/lib/common/menu";

import {
  GEARBOX_MENU_LABEL,
  GearboxMenuContribution,
  GearboxMenus,
  PRODUCT_ACTION_ITEMS,
  registerProductActions,
} from "./menus";
import {
  ADD_PROFILE,
  CLOSE_PRODUCT,
  OPEN_PRODUCT_DESCRIPTION,
  SHOW_PRODUCT_SETTINGS,
} from "./shell/session-command-ids";

describe("the Product view's ⋯ menu", () => {
  function registered(): Array<{ path: MenuPath; commandId: string; label?: string; icon?: string; order?: string }> {
    const actions: Array<{ path: MenuPath; commandId: string; label?: string; icon?: string; order?: string }> = [];
    const registry = {
      registerMenuAction: (path: MenuPath, item: { commandId: string; label?: string; icon?: string; order?: string }) => {
        actions.push({ path, ...item });
        return { dispose: () => undefined };
      },
    } as unknown as MenuModelRegistry;
    registerProductActions(registry);
    return actions;
  }

  it("lives outside the menu bar, as a view's own menu does", () => {
    expect(GearboxMenus.PRODUCT_ACTIONS[0]).not.toBe(MAIN_MENU_BAR[0]);
    for (const group of [GearboxMenus.PRODUCT_ACTIONS_PRODUCT, GearboxMenus.PRODUCT_ACTIONS_CLOSE]) {
      expect(group.slice(0, GearboxMenus.PRODUCT_ACTIONS.length)).toEqual([...GearboxMenus.PRODUCT_ACTIONS]);
    }
  });

  it("offers the product's acts in order, then Close after a separator", () => {
    const actions = registered();
    expect(actions.map((a) => a.label)).toEqual([
      "Product settings",
      "Add profile…",
      "Recheck product",
      "Open GDL",
      "Close product",
    ]);
    // A separator is a group boundary: everything but Close shares one group,
    // and Close's group sorts after it.
    const groups = actions.map((a) => a.path[a.path.length - 1]!);
    expect(new Set(groups.slice(0, 4)).size).toBe(1);
    expect(groups[4]! > groups[0]!).toBe(true);
    expect(actions.every((a) => a.icon?.startsWith("codicon codicon-"))).toBe(true);
  });

  it("names the commands the view contributions register", () => {
    expect(PRODUCT_ACTION_ITEMS.map((a) => a.commandId)).toEqual([
      SHOW_PRODUCT_SETTINGS.id,
      ADD_PROFILE.id,
      "gearbox.product.resolve",
      OPEN_PRODUCT_DESCRIPTION.id,
      CLOSE_PRODUCT.id,
    ]);
  });

  it("leaves the workbench's Explorer, Search and Source control to the workbench", () => {
    const ids = PRODUCT_ACTION_ITEMS.map((a) => a.commandId);
    for (const workbench of ["fileNavigator:toggle", "search-in-workspace.open", "scmView:toggle"]) {
      expect(ids).not.toContain(workbench);
    }
  });
});

describe("the Gearbox top-level menu", () => {
  function registered(): Array<{ path: MenuPath; label: string }> {
    const submenus: Array<{ path: MenuPath; label: string }> = [];
    const registry = {
      registerSubmenu: (path: MenuPath, label: string) => {
        submenus.push({ path, label });
        return { dispose: () => undefined };
      },
    } as unknown as MenuModelRegistry;
    new GearboxMenuContribution().registerMenus(registry);
    return submenus;
  }

  it("gives 3_gearbox a label, which is what Theia 1.75's menu bar draws by", () => {
    // Without a label the node is not a rendered menu node, and the entries
    // registered into it (Add Gear, Resolve, Conflicts, Lock, Generate) were
    // never shown in any mode.
    expect(registered()).toEqual([{ path: [...MAIN_MENU_BAR, "3_gearbox"], label: "Gearbox" }]);
  });

  it("uses the word Studio's Building allow-list keeps it by", () => {
    // theia/studio/src/browser/studio-mode-bar.tsx: Building's `menus` names
    // 'Gearbox'; studio-mode-bar.test.ts checks the other side against this file.
    expect(GEARBOX_MENU_LABEL).toBe("Gearbox");
  });

  it("puts every group the view contributions fill under that one submenu", () => {
    for (const group of [
      GearboxMenus.GEARBOX_INSPECT,
      GearboxMenus.GEARBOX_RESOLVE,
      GearboxMenus.GEARBOX_GENERATE,
      GearboxMenus.GEARBOX_ENGINE,
    ]) {
      expect(group.slice(0, GearboxMenus.GEARBOX.length)).toEqual([...GearboxMenus.GEARBOX]);
    }
  });
});
