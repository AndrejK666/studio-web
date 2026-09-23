// Which directories to hand the engine as source roots.
//
// A managed Studio workspace is a container of checkouts (/workspace holds one
// directory per source, each its own clone), so the workspace folder is the
// wrong root: the engine would see every repository as one source. The root of
// a `gear.gdl` is therefore the repository that holds it, found by walking up
// to the nearest `.git`, and the workspace folder only when there is none.

import { existsSync } from "node:fs";
import * as path from "node:path";

export function sourceRoots(
  folders: readonly string[],
  descriptions: readonly string[],
  isRepository: (dir: string) => boolean = (dir) => existsSync(path.join(dir, ".git")),
): string[] {
  const roots = new Set<string>();
  for (const file of descriptions) {
    const folder = folders
      .filter((candidate) => isInside(candidate, file))
      .sort((a, b) => b.length - a.length)[0];
    if (folder === undefined) {
      continue;
    }
    roots.add(repositoryOf(path.dirname(file), folder, isRepository));
  }
  return [...roots].sort();
}

function repositoryOf(start: string, folder: string, isRepository: (dir: string) => boolean): string {
  for (let dir = start; isInside(folder, dir); dir = path.dirname(dir)) {
    if (isRepository(dir)) {
      return dir;
    }
    if (dir === folder) {
      break;
    }
  }
  return folder;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
