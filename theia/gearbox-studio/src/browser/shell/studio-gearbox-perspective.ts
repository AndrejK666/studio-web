// Constructor Studio: the Gearbox perspective, and opening a product into it.
//
// Studio already opens the IDE in the mode the portal asked for: a document
// from Specs lands in Documents, a file from Sources in the Workbench, the
// artifact graph from Artifacts. A product from Components lands here. This is
// a third arrangement beside Studio's two, chosen by the person (Theia's
// perspective picker) or by the portal (`studio.openProduct`), never by what
// happens to be open: nothing of Studio's is hidden or closed, and switching
// back to the Workbench or to Documents restores their own layouts.

import { ApplicationShell } from "@theia/core/lib/browser";
import { PerspectiveContribution, PerspectiveService } from "@theia/core/lib/browser/perspective-service";
import { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { URI } from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { CatalogueWidget } from "../catalogue/catalogue-widget";
import { ConflictsWidget } from "../conflicts/conflicts-widget";
import { InspectorWidget } from "../inspector/inspector-widget";
import { ProductWidget } from "../product/product-widget";
import { ProductSessionService } from "./product-session-service";
import { PRODUCT_PERSPECTIVE } from "./studio-context-service";

export const OpenProductHere: Command = {
  id: "gearbox.product.openAt",
  label: "Gearbox: Open Product in the Gearbox Perspective",
};

/** The files a portal path can mean, most specific first: absolute; under a
 *  workspace root; under one of a root's checkouts (a managed workspace holds
 *  one directory per source, and the portal names a path inside its repo). */
export function productCandidates(rootUris: readonly string[], checkoutsOf: (root: string) => readonly string[], path: string): string[] {
  const clean = path.replace(/^\/+/, "");
  if (path.startsWith("/") || /^file:/.test(path)) return [path.startsWith("file:") ? path : `file://${path}`];
  const out: string[] = [];
  for (const root of rootUris) out.push(`${root.replace(/\/$/, "")}/${clean}`);
  for (const root of rootUris) for (const dir of checkoutsOf(root)) out.push(`${dir.replace(/\/$/, "")}/${clean}`);
  return out;
}

@injectable()
export class StudioGearboxPerspective implements PerspectiveContribution, CommandContribution {
  @inject(PerspectiveService) protected readonly perspectives!: PerspectiveService;
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(FileService) protected readonly files!: FileService;
  @inject(MessageService) protected readonly messages!: MessageService;

  registerPerspectives(service: PerspectiveService): void {
    service.registerPerspective({
      id: PRODUCT_PERSPECTIVE,
      label: "Gearbox",
      viewPlacements: new Map<string, ApplicationShell.Area>([
        [CatalogueWidget.ID, "left"],
        [ProductWidget.ID, "main"],
        [InspectorWidget.ID, "right"],
        [ConflictsWidget.ID, "bottom"],
      ]),
      primaryViews: { left: CatalogueWidget.ID, right: InspectorWidget.ID },
    });
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenProductHere, {
      execute: (path?: string) => this.openHere(path),
    });
  }

  /** Switch to the Gearbox perspective and open the product at `path`. */
  async openHere(path?: string): Promise<boolean> {
    if (this.perspectives.getActivePerspectiveId() !== PRODUCT_PERSPECTIVE) {
      await this.perspectives.switchPerspective(PRODUCT_PERSPECTIVE).catch(() => undefined);
    }
    if (!path) return false;
    const file = await this.resolve(path);
    if (file === undefined) {
      this.messages.warn(`No ${path} in this workspace. Open the project's repository in Sources first.`);
      return false;
    }
    const roots = this.workspace.tryGetRoots().map((r) => r.resource);
    const root = roots.find((r) => r.isEqualOrParent(file));
    const label = root ? root.relative(file)?.toString() ?? file.path.base : file.path.base;
    return this.session.open({ path: file.path.fsPath(), label });
  }

  protected async resolve(path: string): Promise<URI | undefined> {
    const roots = this.workspace.tryGetRoots();
    const checkouts = new Map<string, string[]>();
    for (const root of roots) {
      const children = root.children ?? (await this.files.resolve(root.resource).catch(() => undefined))?.children ?? [];
      checkouts.set(
        root.resource.toString(),
        children.filter((c) => c.isDirectory && !c.name.startsWith(".")).map((c) => c.resource.toString()),
      );
    }
    for (const candidate of productCandidates(
      roots.map((r) => r.resource.toString()),
      (root) => checkouts.get(root) ?? [],
      path,
    )) {
      const uri = new URI(candidate);
      if (await this.files.exists(uri)) return uri;
    }
    return undefined;
  }
}
