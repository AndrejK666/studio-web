import "reflect-metadata";

import { MAIN_MENU_BAR } from "@theia/core/lib/common/menu";
import type { MenuModelRegistry, MenuPath } from "@theia/core/lib/common/menu";

import { GEARBOX_MENU_LABEL, GearboxMenuContribution, GearboxMenus } from "./menus";

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
