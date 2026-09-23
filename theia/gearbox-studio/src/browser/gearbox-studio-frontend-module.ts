// Frontend wiring for Gearbox inside Constructor Studio.
//
// Ported from Gearbox Studio (github.com/MikeFalcon77/gearbox@7594c25,
// ide/gearbox-studio). The domain — the catalogue, the product, its edits, the
// graph, the inspector, the lock, conflicts, generation, the wizards — is
// bound as it was. What Gearbox Studio did to the shell is not: it was a whole
// IDE and narrowed Theia by rebinding (ADR-0011 there), which here would hide
// Studio's own views. Those rebinds are not ported, and every service that
// still arranges panels asks `gearboxOwnsLayout` first (shell/gearbox-shell-gate.ts).
//
// Phased (see theia/gearbox-studio/README.md): the chat agent is P5, and the
// Gearbox perspective with its toolbar, screen scope and themes is P6. Until
// then nothing here opens a view on its own except the Product view, when a
// person opens a product.

import { FrontendApplicationContribution, bindViewContribution } from "@theia/core/lib/browser";
import { WebSocketConnectionProvider } from "@theia/core/lib/browser/messaging";
import { PerspectiveContribution } from "@theia/core/lib/browser/perspective-service";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ContainerModule, injectable } from "@theia/core/shared/inversify";
import { MonacoEditorProvider } from "@theia/monaco/lib/browser/monaco-editor-provider";
import { LanguageGrammarDefinitionContribution } from "@theia/monaco/lib/browser/textmate/textmate-contribution";

import { GEARBOX_SERVICE_PATH, GearboxClient, GearboxService } from "../common/protocol";
import { CatalogueStore } from "./catalogue-store";
import { GenerateService } from "./generate/generate-service";
import { ProductEditService } from "./product-edit-service";
import { ProductStore } from "./product-store";
import { ResolutionMarkers } from "./resolution-markers";
import { bindWidget } from "./contribution";
import { ReadOnlyLockEditorProvider } from "./theia/monaco/read-only-lock-editor-provider";
import { RevealService } from "./reveal-service";
import { CataloguePicker } from "./catalogue/catalogue-picker";
import { CatalogueWidget } from "./catalogue/catalogue-widget";
import { ConflictsWidget } from "./conflicts/conflicts-widget";
import { CreateProductWidget } from "./create/create-product-widget";
import { CreateGearWidget } from "./create/create-gear-widget";
import { PendingCreate } from "./create/pending-create";
import { PendingCreateGear } from "./create/pending-create-gear";
import {
  AddGearViewContribution,
  CatalogueViewContribution,
  ConflictsViewContribution,
  CreateGearViewContribution,
  CreateProductViewContribution,
  GearAuthorViewContribution,
  GenerateViewContribution,
  GraphViewContribution,
  InspectorViewContribution,
  LockViewContribution,
  ProductViewContribution,
  StartViewContribution,
} from "./view-contributions";
import { GraphWidget } from "./graph/graph-widget";
import { InspectorWidget } from "./inspector/inspector-widget";
import { GenerateWidget } from "./generate/generate-widget";
import { LockWidget } from "./lock/lock-widget";
import { ProductWidget } from "./product/product-widget";
import { GearAuthorWidget } from "./gear/gear-author-widget";
import { StartWidget } from "./start/start-widget";
import { DescriptionMarkers } from "./gdl/description-markers";
import { GdlAssistContribution } from "./gdl/gdl-assist-contribution";
import { GdlLanguageContribution } from "./gdl/gdl-language-contribution";
import { ProductFileChecks } from "./gdl/product-file-checks";
import { GearSessionService } from "./shell/gear-session-service";
import { ProductSessionService } from "./shell/product-session-service";
import { EngineConnectionService } from "./shell/engine-connection-service";
import { SelectionService } from "./shell/selection-service";
import { SessionCommands } from "./shell/session-commands";
import { FocusModeService } from "./shell/focus-mode-service";
import { DescriptionWatchService } from "./shell/description-watch-service";
import { ScreenScopeService } from "./shell/screen-scope-service";
import { StudioContextService } from "./shell/studio-context-service";
import { StudioGearboxPerspective } from "./shell/studio-gearbox-perspective";
import { GearLocator } from "./shell/gear-locator";
import { PortalLinkContribution } from "./shell/portal-link";

import "../../src/browser/style/index.css";

/**
 * Constructor Studio: the catalogue loads with the application and opens only
 * when asked. Gearbox Studio also opened it from `initializeLayout` on a first
 * run, which here would put a Gearbox panel in front of Studio's Explorer for
 * every project, product or not.
 */
@injectable()
class StudioCatalogueViewContribution extends CatalogueViewContribution {
  override async initializeLayout(): Promise<void> {}
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // `product.lock` opens read-only. Additive: nothing else in Studio rebinds
  // the Monaco editor provider, and every other file opens as before.
  rebind(MonacoEditorProvider).to(ReadOnlyLockEditorProvider).inSingletonScope();

  // One selection for every Gearbox view, bound before the stores that inject it.
  bind(SelectionService).toSelf().inSingletonScope();
  bind(EngineConnectionService).toSelf().inSingletonScope();

  bind(CatalogueStore).toSelf().inSingletonScope();
  bind(ProductStore).toSelf().inSingletonScope();
  bind(ProductEditService).toSelf().inSingletonScope();
  bind(PendingCreate).toSelf().inSingletonScope();
  bind(PendingCreateGear).toSelf().inSingletonScope();
  bind(GenerateService).toSelf().inSingletonScope();
  bind(RevealService).toSelf().inSingletonScope();
  bind(GearboxClient).toService(CatalogueStore);

  // Resolution diagnostics into the Problems view, under their own owner.
  bind(ResolutionMarkers).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ResolutionMarkers);

  // The `.gdl` language, natively: the grammar (Monaco has no other), the
  // description markers from the engine's `textDocument/*` surface, completion
  // and hover, and the catalogue checks on any product.gdl opened as a file.
  // These replace theia/gdl-language, so one engine serves the editor and the
  // views instead of two.
  bind(LanguageGrammarDefinitionContribution).to(GdlLanguageContribution).inSingletonScope();
  bind(DescriptionMarkers).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(DescriptionMarkers);
  bind(GdlAssistContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(GdlAssistContribution);
  bind(ProductFileChecks).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ProductFileChecks);

  bind(ProductSessionService).toSelf().inSingletonScope();
  bind(GearSessionService).toSelf().inSingletonScope();

  // Open, New and Close Product under File.
  bind(SessionCommands).toSelf().inSingletonScope();
  bind(CommandContribution).toService(SessionCommands);
  bind(MenuContribution).toService(SessionCommands);

  // The context keys (`gearbox.context`, `gearbox.hasSelection`) and the
  // change events the views follow. Its perspective switch is gated.
  bind(StudioContextService).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(StudioContextService);

  // Re-resolve when a description is saved.
  bind(DescriptionWatchService).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(DescriptionWatchService);

  // Injected by the views; neither acts outside a Gearbox perspective, and
  // neither is an application contribution until P6, so nothing reconciles
  // Studio's layout on its own.
  bind(FocusModeService).toSelf().inSingletonScope();
  bind(ScreenScopeService).toSelf().inSingletonScope();

  // The Gearbox perspective beside Workbench and Documents, and the command
  // the portal's `studio.openProduct` runs to land in it with a product open.
  // From a gear here to its page in the portal's component catalogue.
  bind(PortalLinkContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(PortalLinkContribution);

  bind(GearLocator).toSelf().inSingletonScope();
  bind(StudioGearboxPerspective).toSelf().inSingletonScope();
  bind(PerspectiveContribution).toService(StudioGearboxPerspective);
  bind(CommandContribution).toService(StudioGearboxPerspective);

  bind(GearboxService)
    .toDynamicValue(({ container }) => {
      const provider = container.get(WebSocketConnectionProvider);
      // The client is reached through a forwarder, not resolved here: the store
      // injects the service and the service needs a client, a cycle inversify
      // refuses in toDynamicValue bindings.
      const forwarder: GearboxClient = {
        onCatalogueChanged: (event) => container.get(CatalogueStore).onCatalogueChanged(event),
        onCatalogueDiagnostics: (event) => container.get(CatalogueStore).onCatalogueDiagnostics(event),
        onProgress: (event) => container.get(CatalogueStore).onProgress(event),
        onLog: (message) => container.get(CatalogueStore).onLog(message),
        onEngineExit: (reason) => container.get(CatalogueStore).onEngineExit(reason),
        onDocumentDiagnostics: (params) => container.get(DescriptionMarkers).onDocumentDiagnostics(params),
      };
      return provider.createProxy<GearboxService>(GEARBOX_SERVICE_PATH, forwarder);
    })
    .inSingletonScope();

  // `Find Gear…` and `Add Gear…`.
  bind(CataloguePicker).toSelf().inSingletonScope();
  bind(CommandContribution).toService(CataloguePicker);
  bind(MenuContribution).toService(CataloguePicker);

  bindWidget(bind, CatalogueWidget);
  bindWidget(bind, GraphWidget);
  bindWidget(bind, ProductWidget);
  bindWidget(bind, InspectorWidget);
  bindWidget(bind, ConflictsWidget);
  bindWidget(bind, StartWidget);
  bindWidget(bind, CreateProductWidget);
  bindWidget(bind, CreateGearWidget);
  bindWidget(bind, GearAuthorWidget);
  bindWidget(bind, LockWidget);
  bindWidget(bind, GenerateWidget);

  // Every view is reachable from View → Views and its command. None opens at
  // start-up: `initializeLayout` and `onStart` belong to a view contribution
  // only when it is also bound as an application contribution, and only the
  // Product view is — it opens when a person opens a product.
  // Loaded at start (its `onStart` starts the engine and the staged load, and
  // reloads after a reconnect), opened only when asked: see the subclass.
  bindViewContribution(bind, StudioCatalogueViewContribution);
  bind(FrontendApplicationContribution).toService(StudioCatalogueViewContribution);
  bindViewContribution(bind, InspectorViewContribution);
  bindViewContribution(bind, GraphViewContribution);
  bindViewContribution(bind, ProductViewContribution);
  bind(FrontendApplicationContribution).toService(ProductViewContribution);
  bindViewContribution(bind, StartViewContribution);
  bindViewContribution(bind, CreateProductViewContribution);
  bindViewContribution(bind, CreateGearViewContribution);
  bindViewContribution(bind, GearAuthorViewContribution);
  bindViewContribution(bind, AddGearViewContribution);
  bindViewContribution(bind, ConflictsViewContribution);
  bindViewContribution(bind, LockViewContribution);
  bindViewContribution(bind, GenerateViewContribution);
});
