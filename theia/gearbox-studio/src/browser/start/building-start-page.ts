// Constructor Studio: Building's start page, in the empty main dock.
//
// The empty dock is product-ext's layer (welcome-view.js); each mode's page is
// registered into its registry (./start-page-hub.ts) by the package that holds
// the page's data. This one is the Product view's empty state brought forward --
// the workspace's products and Recent (`emptyStateLists`, the same lists), New
// and Open Product -- plus the catalogue's size and New gear. Read when the page
// is shown: `ensureDiscovered` answers at once when the products are already in
// hand, and Recent is `StorageService`'s.
//
// The buttons run the commands the File menu and the ribbon run; product-ext
// draws only those this build has, disabled with the reason when the engine
// is down.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { DisposableCollection } from "@theia/core/lib/common/disposable";
import { inject, injectable } from "@theia/core/shared/inversify";

import { CatalogueStore } from "../catalogue-store";
import { ProductStore } from "../product-store";
import { emptyStateLists } from "../product/product-empty-state";
import { EngineConnectionService } from "../shell/engine-connection-service";
import { ProductSessionService, type RecentEntry } from "../shell/product-session-service";
import { BROWSE_CATALOGUE, NEW_GEAR, NEW_PRODUCT, OPEN_PRODUCT } from "../shell/session-command-ids";
import { catalogueSection, productSections, type ProductRowData } from "./building-start-model";
import { registerStartPage, type StartAction, type StartPageModel, type StartRow } from "./start-page-hub";

/** Building's perspective, `PRODUCT_PERSPECTIVE` (Studio's `BUILDING_PERSPECTIVE_ID`). */
const BUILDING_PERSPECTIVE_ID = "gearbox.product";

/** How long the page waits for discovery before listing what it has. */
const DISCOVERY_TIMEOUT_MS = 10000;

@injectable()
export class BuildingStartPage implements FrontendApplicationContribution {
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;

  protected readonly toDispose = new DisposableCollection();

  onStart(): void {
    this.toDispose.push(
      registerStartPage({
        id: "gearbox.building",
        modes: [BUILDING_PERSPECTIVE_ID],
        label: "Building",
        summary: "Compose the product out of gears, and generate it",
        actions: this.actions(),
        load: () => this.load(),
        watch: (reload) => {
          const watching = new DisposableCollection();
          watching.push(this.products.onChanged(() => reload()));
          watching.push(this.catalogue.onChanged(() => reload()));
          watching.push(this.engine.onDidChange(() => reload()));
          return watching;
        },
      }),
    );
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  /** New and Open Product, New gear, Catalogue: the Start screen's, by command. */
  protected actions(): StartAction[] {
    const connected = this.engine.isConnected;
    const reason = "the Gearbox engine is not running";
    return [
      { id: "new-product", label: "New Product", command: NEW_PRODUCT.id, title: "Compose a new product from gears", enabled: connected ? undefined : false, reason },
      { id: "open-product", label: "Open Product", command: OPEN_PRODUCT.id, title: "Open a product description and resolve it" },
      { id: "new-gear", label: "New gear", command: NEW_GEAR.id, title: "Write a new gear: its gear.gdl and code, in a source of the corpus", enabled: connected ? undefined : false, reason },
      { id: "catalogue", label: "Catalogue", command: BROWSE_CATALOGUE.id, title: "Every gear the corpus describes" },
    ];
  }

  protected async load(): Promise<StartPageModel> {
    let discoveryNote: string | undefined;
    try {
      await Promise.race([
        this.products.ensureDiscovered(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("discovery is taking long")), DISCOVERY_TIMEOUT_MS)),
      ]);
    } catch (error) {
      discoveryNote = `The workspace's products could not be listed: ${error instanceof Error ? error.message : String(error)}.`;
    }
    let recent: readonly RecentEntry[] = [];
    try {
      recent = await this.session.recentEntries();
    } catch {
      recent = [];
    }
    const connected = this.engine.isConnected;
    const lists = emptyStateLists(this.products.current.products, recent);
    const { workspace, recent: remembered } = productSections(lists, connected, this.engine.disconnectReason);
    const catalogue = catalogueSection(this.catalogue.current);
    return {
      actions: this.actions(),
      sections: [
        {
          ...workspace,
          note: [workspace.note, discoveryNote].filter(Boolean).join(" ") || undefined,
          rows: workspace.rows.map((row) => this.productRow(row)),
          column: 0,
        },
        { ...remembered, rows: remembered.rows.map((row) => this.productRow(row)), column: 1 },
        {
          ...catalogue,
          rows: catalogue.rows.map((row) => ({ ...row, command: BROWSE_CATALOGUE.id })),
          column: 1,
        },
      ],
    };
  }

  /** A product row opens it the way the Product view's empty state does. */
  protected productRow(row: ProductRowData): StartRow {
    const ref = { path: row.ref.path, label: row.ref.label };
    return {
      name: row.name,
      folder: row.folder,
      tag: row.tag,
      title: row.title,
      enabled: row.enabled,
      reason: row.reason,
      // `openRecent` for a remembered one: its path may have rotted, and that
      // call is the one that forgets it and says so.
      activate: () => (row.kind === "recent" ? this.session.openRecent(ref) : this.session.open(ref)),
    };
  }
}
