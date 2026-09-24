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
import { QuickInputService } from "@theia/core/lib/common/quick-pick-service";
import { URI } from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { CatalogueWidget } from "../catalogue/catalogue-widget";
import { ConflictsWidget } from "../conflicts/conflicts-widget";
import { InspectorWidget } from "../inspector/inspector-widget";
import { ProductWidget } from "../product/product-widget";
import { GearAuthorViewContribution } from "../view-contributions";
import { GearLocator } from "./gear-locator";
import { GearSessionService } from "./gear-session-service";
import { ProductSessionService } from "./product-session-service";
import { GearboxService } from "../../common/protocol";
import { PRODUCT_PERSPECTIVE } from "./studio-context-service";

export const OpenProductHere: Command = {
  id: "gearbox.product.openAt",
  label: "Gearbox: Open Product in the Gearbox Perspective",
};

export const OpenGearHere: Command = {
  id: "gearbox.gear.openAt",
  label: "Gearbox: Open Gear in the Gearbox Perspective",
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
  @inject(GearboxService) protected readonly gearbox!: GearboxService;
  @inject(GearSessionService) protected readonly gearSession!: GearSessionService;
  @inject(GearLocator) protected readonly locator!: GearLocator;
  @inject(GearAuthorViewContribution) protected readonly gearView!: GearAuthorViewContribution;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;

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
      execute: (path?: string, branch?: string) => this.openHere(path, branch),
    });
    commands.registerCommand(OpenGearHere, {
      execute: (path?: string) => this.openGearHere(path),
    });
  }

  /**
   * Switch to the Gearbox perspective and open a gear for authoring.
   *
   * `path` is the gear's directory or its `gear.gdl`, resolved the way a
   * product's is. Without one -- the portal's "Open in IDE" on a gear project,
   * which knows the repository but not where in it the gear went -- the
   * project's gears are looked for, the corpus excluded: one is opened, several
   * are offered, none is said.
   */
  async openGearHere(path?: string): Promise<boolean> {
    if (this.perspectives.getActivePerspectiveId() !== PRODUCT_PERSPECTIVE) {
      await this.perspectives.switchPerspective(PRODUCT_PERSPECTIVE).catch(() => undefined);
    }
    let root: string | undefined;
    if (path) {
      const wanted = path.replace(/\\/g, "/").replace(/\/+$/, "");
      const file = await this.resolve(wanted.endsWith("/gear.gdl") ? wanted : `${wanted}/gear.gdl`);
      if (file === undefined) {
        this.messages.warn(`No gear.gdl at ${path} in this workspace.`);
        return false;
      }
      root = file.parent.path.fsPath();
    } else {
      const gears = await this.locator.gears();
      if (gears.length === 0) {
        this.messages.info("This workspace has no gear with a gear.gdl yet. Use New Gear to describe one.");
        return false;
      }
      root =
        gears.length === 1
          ? gears[0]
          : (
              await this.quickInput.showQuickPick(
                gears.map((g) => ({ label: g.split("/").pop() ?? g, description: g, root: g })),
                { placeholder: "Open Gear" },
              )
            )?.root;
    }
    if (root === undefined) return false;
    if (!(await this.gearSession.openGear(root))) return false;
    await this.gearView.openView({ activate: true, reveal: true });
    return true;
  }

  /** Switch to the Gearbox perspective and open the product at `path`. */
  async openHere(path?: string, branch?: string): Promise<boolean> {
    if (this.perspectives.getActivePerspectiveId() !== PRODUCT_PERSPECTIVE) {
      await this.perspectives.switchPerspective(PRODUCT_PERSPECTIVE).catch(() => undefined);
    }
    if (!path) return false;
    // The portal saves a product onto its own branch when the repository is
    // shared; the session is on the base branch. The branch is then brought
    // in beside the checkout (`fileOnBranch`), and the copy there is opened.
    const onBranch =
      branch === undefined ? undefined : await this.gearbox.fileOnBranch(branch, path).catch(() => undefined);
    const file = onBranch !== undefined ? URI.fromFilePath(onBranch) : await this.resolve(path);
    if (file === undefined) {
      this.messages.warn(
        branch === undefined
          ? `No ${path} in this workspace. Open the project's repository in Sources first.`
          : `No ${path} in this workspace, and its branch ${branch} could not be fetched from the project's repository.`,
      );
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
