// Constructor Studio: from a gear here to its page in the portal's catalogue.
//
// The component catalogue — owners, delivery activity, documents, published
// versions, and since #361 what this engine says about the gear — is a portal
// page, and the IDE runs in the portal's frame. The message goes out through
// Studio's own portal bridge (`studio.portal.openComponent`, registered by the
// studio package), which knows the portal's origin; this package names the
// command by id so it does not depend on studio.

import { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { inject, injectable } from "@theia/core/shared/inversify";

import { CatalogueStore } from "../catalogue-store";
import { gearIdOf, SelectionService } from "./selection-service";

/** Registered by studio's PortalBridgeContribution. */
export const OPEN_COMPONENT_IN_PORTAL = "studio.portal.openComponent";

export const OpenSelectedGearInCatalogue: Command = {
  id: "gearbox.gear.openInCatalogue",
  label: "Gearbox: Open Selected Gear in the Component Catalogue",
};

/** Whether this window is embedded, which is the only place the page exists. */
export function inPortal(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true; // a cross-origin parent throws on access, and is a parent
  }
}

@injectable()
export class PortalLinkContribution implements CommandContribution {
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenSelectedGearInCatalogue, {
      isEnabled: () => inPortal() && this.selectedCrate() !== undefined,
      isVisible: () => inPortal(),
      execute: () => {
        const crate = this.selectedCrate();
        if (crate !== undefined) void commands.executeCommand(OPEN_COMPONENT_IN_PORTAL, crate);
      },
    });
  }

  protected selectedCrate(): string | undefined {
    const current = this.selection.current;
    if (current === undefined) return undefined;
    const id = current.kind === "plugin" ? current.id : gearIdOf(current);
    if (id === undefined) return undefined;
    const row = this.catalogue.current.rows.find((r) => r.kind === "projected" && r.gear.id === id);
    return row?.kind === "projected" ? row.gear.package.crate_name : undefined;
  }
}
