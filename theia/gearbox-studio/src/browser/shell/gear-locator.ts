// Constructor Studio: the project's gears, read off the workspace.
//
// A bounded walk rather than a file search: the gears are at most four
// directories down, the corpus checkout is skipped whole, and a walk needs
// nothing beyond the FileService this package already depends on.

import { URI } from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { gearRoots, newGearDestination, walkInto } from "./gear-locations";

@injectable()
export class GearLocator {
  @inject(FileService) protected readonly files!: FileService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;

  /** Absolute directories of the gears in the workspace, the corpus excluded. */
  async gears(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: URI, depth: number): Promise<void> => {
      const stat = await this.files.resolve(dir).catch(() => undefined);
      for (const child of stat?.children ?? []) {
        if (child.isFile && child.name === "gear.gdl") found.push(child.resource.path.fsPath());
        else if (child.isDirectory && walkInto(child.name, depth + 1)) await walk(child.resource, depth + 1);
      }
    };
    for (const root of this.workspace.tryGetRoots()) await walk(root.resource, 0);
    return gearRoots(found);
  }

  /** Where New Gear puts a gear when nobody has said. */
  async newGearDestination(): Promise<string> {
    const root = this.workspace.tryGetRoots()[0];
    if (root === undefined) return "";
    const stat = await this.files.resolve(root.resource).catch(() => undefined);
    const children = stat?.children ?? [];
    // A root that is itself a repository has folders, not checkouts.
    const checkouts = children.some((c) => c.name === ".git")
      ? []
      : children.filter((c) => c.isDirectory && !c.name.startsWith(".")).map((c) => c.resource.path.fsPath());
    return newGearDestination(root.resource.path.fsPath(), checkouts, await this.gears());
  }
}
