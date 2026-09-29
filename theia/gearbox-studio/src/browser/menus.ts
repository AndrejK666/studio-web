// Every menu path in one place, and the two helpers removal needs.
//
// Collected rather than scattered because a menu path is a string array whose
// last element is a node id, and the same id appearing in two files is how a
// removal silently stops matching. Arduino IDE keeps one `arduino-menus.ts` for
// exactly this reason.

import { MAIN_MENU_BAR } from "@theia/core/lib/common/menu";
import type { MenuContribution, MenuModelRegistry, MenuPath } from "@theia/core/lib/common/menu";
import { injectable } from "@theia/core/shared/inversify";

export namespace GearboxMenus {
  /**
   * The domain menu, between Edit (`2_`) and View (`4_`).
   *
   * Slot `3_` is the one Monaco's Selection menu occupies, and Selection is
   * removed -- so this takes the place a general editor would have used, which
   * is the whole point of the exercise.
   */
  export const GEARBOX: MenuPath = [...MAIN_MENU_BAR, "3_gearbox"];

  /** Reload the catalogue, validate: things that read. */
  export const GEARBOX_INSPECT: MenuPath = [...GEARBOX, "1_inspect"];
  /** Resolve, explain: things that compute. */
  export const GEARBOX_RESOLVE: MenuPath = [...GEARBOX, "2_resolve"];
  /** Preview and apply a generated tree. */
  export const GEARBOX_GENERATE: MenuPath = [...GEARBOX, "3_generate"];
  /** Restart the engine: things that act on the tool itself. */
  export const GEARBOX_ENGINE: MenuPath = [...GEARBOX, "9_engine"];
}

/**
 * Constructor Studio: the domain menu's label, and the name Studio's mode
 * allow-list keeps it by (`theia/studio/src/browser/studio-mode-bar.tsx`,
 * Building's `menus`). The two must be the same word; a test in each package
 * says so.
 */
export const GEARBOX_MENU_LABEL = "Gearbox";

/**
 * Constructor Studio: give `3_gearbox` a label, so the menu bar draws it.
 *
 * Gearbox Studio labelled it from `ShellPolicy`, one of the shell rebinds that
 * are not ported. Theia 1.75's menu bar renders only labelled top-level nodes
 * (`BrowserMainMenuFactory.fillMenuBar`), so without this the entries below --
 * Add Gear, Resolve, Conflicts, Resolution Lock, Generate -- were registered
 * into a menu nobody could see. Each entry keeps its own
 * `gearbox.context == 'product'` gate, and Theia omits a submenu whose entries
 * are all hidden, so with no product open there is no Gearbox menu; which
 * modes show it at all is Studio's allow-list.
 */
@injectable()
export class GearboxMenuContribution implements MenuContribution {
  registerMenus(registry: MenuModelRegistry): void {
    registry.registerSubmenu(GearboxMenus.GEARBOX, GEARBOX_MENU_LABEL);
  }
}

/**
 * Where a terminal, the Explorer, Search and git live once they stop being
 * top-level concerns.
 *
 * Kept, not removed -- ADR-0011 keeps the editor stack on purpose, because the
 * work ends in generated crates a person will want to read, diff and build. But
 * they are tools, not one of the two things this application is about, so they
 * sit one level down instead of competing with `Product` for the menu bar.
 */
/**
 * Where opening and closing a product live: `File`, above the generic entries.
 *
 * A group of its own so ordering is ours rather than a fight with whatever
 * `@theia/workspace` registers -- and so a reader sees the product verbs first,
 * which is what `File` is for in an application whose documents are products.
 */
export const FILE_PRODUCT: MenuPath = [...MAIN_MENU_BAR, "1_file", "0_product"];

/**
 * `View > 1_catalogue`: the two acts on the gear catalogue.
 *
 * Under View because the catalogue is a panel and these are things done to it;
 * under *Product* they made a menu about a product offer work that has nothing to
 * do with one, and they stayed enabled with no product open.
 */
export const VIEW_CATALOGUE: MenuPath = [...MAIN_MENU_BAR, "4_view", "1_catalogue"];
