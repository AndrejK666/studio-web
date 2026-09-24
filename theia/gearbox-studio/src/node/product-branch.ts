// Constructor Studio: a product description that lives on a branch.
//
// The portal saves a product's `product.gdl` onto its own branch when the
// project's repository is shared (`product/<id>-<digest>`), and a session
// clones that repository on its base branch -- so "Open in IDE" arrived at a
// workspace without the file it was asked to open.
//
// The branch is brought in as a git worktree beside the checkout, never by
// switching the checkout itself: one session is shared by everybody who opens
// the workspace, and a checkout moving under an open editor is the kind of
// surprise nobody asked for. Beside it, too, because a description names its
// gears from `../gears-rust`, and a sibling of the corpus keeps that true.

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const git = promisify(execFile);

/** A branch name this will pass to git: refs git itself would accept, and
 *  nothing that could be read as an option. */
export function isSafeBranch(branch: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(branch) &&
    !branch.startsWith("-") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith(".lock")
  );
}

/** A relative file path inside a checkout, never one that climbs out. */
export function isSafeRelative(file: string): boolean {
  const norm = path.posix.normalize(file.replace(/\\/g, "/"));
  return norm !== "" && !norm.startsWith("..") && !path.posix.isAbsolute(norm);
}

/** `studio-web` + `product/studioweb-77a0da49` -> `studio-web@product-studioweb-77a0da49`. */
export function worktreeDirName(checkout: string, branch: string): string {
  return `${checkout}@${branch.replace(/\//g, "-")}`;
}

function checkoutsOf(workspace: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.includes("@"))
    .map((e) => path.join(workspace, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, ".git")));
}

async function run(args: string[]): Promise<string> {
  const { stdout } = await git("git", args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * The absolute path of `file` as it is on `branch`, bringing the branch into
 * the workspace first when no checkout has it. `undefined` when no checkout's
 * `origin` has that branch, or the file is not on it.
 */
export async function fileOnBranch(workspace: string, branch: string, file: string): Promise<string | undefined> {
  if (!isSafeBranch(branch) || !isSafeRelative(file)) return undefined;
  for (const checkout of checkoutsOf(workspace)) {
    // Already there: a person switched to it, or an earlier open brought it in.
    const current = await run(["-C", checkout, "branch", "--show-current"]).catch(() => "");
    if (current === branch && fs.existsSync(path.join(checkout, file))) return path.join(checkout, file);
    const target = path.join(workspace, worktreeDirName(path.basename(checkout), branch));
    if (fs.existsSync(target)) {
      // Brought in before: catch up with what the portal saved since.
      await run(["-C", target, "pull", "--ff-only", "--quiet"]).catch(() => undefined);
      if (fs.existsSync(path.join(target, file))) return path.join(target, file);
      continue;
    }
    const fetched = await run([
      "-C",
      checkout,
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ])
      .then(() => true)
      .catch(() => false);
    if (!fetched) continue;
    await run(["-C", checkout, "worktree", "add", "--quiet", "--track", "-B", branch, target, `origin/${branch}`]);
    if (fs.existsSync(path.join(target, file))) return path.join(target, file);
  }
  return undefined;
}
