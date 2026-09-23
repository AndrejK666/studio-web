// Constructor Studio: where the engine, its source roots and the workspace are.
//
// Gearbox Studio ran from a checkout of the gearbox repository: the engine was
// `target/debug/gearbox` in that Cargo workspace, the gear corpus the
// `../gears-rust` beside it, and the products `products/*/product.gdl`. A
// Constructor Studio session has none of that. It has one directory,
// `/workspace`, holding one checkout per source (`/workspace/gears-rust`,
// `/workspace/<project>`), and the engine installed at `/usr/local/bin/gearbox`
// by the session image.

import * as fs from "fs";
import * as path from "path";

/** Directories never worth descending into when looking for descriptions. */
const SKIP = new Set(["node_modules", "target", ".git", ".gearbox", "dist", "lib"]);
/** Deep enough for `gears/system/authn-resolver/plugins/x/gear.gdl`. */
const MAX_DEPTH = 7;

export function workspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GEARBOX_WORKSPACE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return fs.existsSync("/workspace") ? "/workspace" : process.cwd();
}

export function enginePath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GEARBOX_ENGINE?.trim();
  if (fromEnv) return fromEnv;
  // On PATH, where the session image puts it. `.exe` on Windows, because
  // `spawn` does not add it and the failure is an ENOENT for a binary that is
  // right there.
  return process.platform === "win32" ? "gearbox.exe" : "gearbox";
}

/**
 * The source roots the engine scans: `GEARBOX_ROOT` when set (one path, or
 * several separated by the platform's path delimiter), otherwise every
 * checkout directly under the workspace that holds a `gear.gdl`. A checkout,
 * not the workspace: the engine names a source after its root, and a product
 * says `source(id = "gears-rust", ...)`.
 */
export function sourceRoots(env: NodeJS.ProcessEnv = process.env, workspace = workspaceDir(env)): string[] {
  const fromEnv = env.GEARBOX_ROOT?.trim();
  if (fromEnv) {
    return fromEnv
      .split(path.delimiter)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => path.resolve(p));
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith("."))
    .map((e) => path.join(workspace, e.name))
    .filter((dir) => holdsDescription(dir, 0))
    .sort();
}

function holdsDescription(dir: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some((e) => e.isFile() && e.name === "gear.gdl")) return true;
  return entries.some(
    (e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".") && holdsDescription(path.join(dir, e.name), depth + 1),
  );
}

/**
 * The products a person can open: `<checkout>/product.gdl`, which is where
 * Studio's portal saves one, and `<checkout>/products/<name>/product.gdl`, the
 * layout the gearbox repository itself uses.
 */
export function productFiles(workspace = workspaceDir()): string[] {
  const out: string[] = [];
  let checkouts: fs.Dirent[];
  try {
    checkouts = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  const consider = (file: string) => {
    if (fs.existsSync(file)) out.push(file);
  };
  consider(path.join(workspace, "product.gdl"));
  for (const c of checkouts) {
    if (!c.isDirectory() || SKIP.has(c.name) || c.name.startsWith(".")) continue;
    const dir = path.join(workspace, c.name);
    consider(path.join(dir, "product.gdl"));
    let products: fs.Dirent[];
    try {
      products = fs.readdirSync(path.join(dir, "products"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const p of products) {
      if (p.isDirectory()) consider(path.join(dir, "products", p.name, "product.gdl"));
    }
  }
  return out.sort();
}
