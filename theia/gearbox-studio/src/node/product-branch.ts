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
//
// The desktop is the exception: its checkout is one person's, and a worktree
// beside it holds the branch, so git then refuses to switch the checkout to
// it -- the person could not move onto the branch the product is on. There
// the checkout itself is switched, when nothing in it is left uncommitted.
//
// ADR-0053 §4 narrowed this: a `product/…` branch lends only its description
// (`descriptionFromBranch`), because its code is as old as the save and a
// build of it compiled yesterday's code. The whole branch is brought in only
// for any other branch a person explicitly asks for.

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

/** Windows: a project's checkout holds paths past MAX_PATH, which git refuses without this ("Filename too long"). */
const LONG_PATHS = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];

async function run(args: string[]): Promise<string> {
  const { stdout } = await git("git", [...LONG_PATHS, ...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/** `origin`'s `branch` into its remote-tracking ref; `false` when origin has none. */
function fetchBranch(checkout: string, branch: string): Promise<boolean> {
  return run(["-C", checkout, "fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
    .then(() => true)
    .catch(() => false);
}

/** Nothing uncommitted: switching away loses nothing. */
async function isClean(dir: string): Promise<boolean> {
  return (await run(["-C", dir, "status", "--porcelain"]).catch(() => "?")) === "";
}

/** No change to a tracked file: switching away loses nothing, and what a build left untracked moves along. */
async function noTrackedChanges(dir: string): Promise<boolean> {
  return (await run(["-C", dir, "status", "--porcelain", "--untracked-files=no"]).catch(() => "?")) === "";
}

/** The branch `origin` names as its default, `main` when it names none. */
async function baseBranch(checkout: string): Promise<string> {
  const ref = await run(["-C", checkout, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  return ref.replace(/^origin\//, "") || "main";
}

/**
 * A checkout an earlier desktop switched onto a product branch, back onto the
 * repository's base branch, brought up to date: the product branch's code is
 * as old as its save (ADR-0053 §4). `false` when that cannot be done without
 * losing work, or git refuses; the checkout then stays where it is.
 */
async function leaveProductBranch(checkout: string): Promise<boolean> {
  if (!(await noTrackedChanges(checkout))) return false;
  const base = await baseBranch(checkout);
  if (!isSafeBranch(base) || isProductBranch(base) || !(await fetchBranch(checkout, base))) return false;
  try {
    if (await hasLocalBranch(checkout, base)) {
      await run(["-C", checkout, "switch", "--quiet", base]);
      await run(["-C", checkout, "merge", "--ff-only", "--quiet", `origin/${base}`]).catch(() => undefined);
    } else {
      await run(["-C", checkout, "switch", "--quiet", "--track", "-c", base, `origin/${base}`]);
    }
    return true;
  } catch {
    return false;
  }
}

async function hasLocalBranch(checkout: string, branch: string): Promise<boolean> {
  return run(["-C", checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
}

/**
 * The desktop's way: the checkout itself onto `branch`, once it is fetched. A
 * worktree an earlier open left beside it is taken away first when nothing in
 * it is uncommitted, since it holds the branch. `false` when the checkout
 * cannot be switched without losing work -- the caller brings the branch in
 * beside it instead.
 */
async function switchCheckout(checkout: string, target: string, branch: string): Promise<boolean> {
  if (!(await isClean(checkout))) return false;
  if (fs.existsSync(target)) {
    if (!(await isClean(target))) return false;
    await run(["-C", checkout, "worktree", "remove", target]);
  }
  if (await hasLocalBranch(checkout, branch)) {
    await run(["-C", checkout, "switch", "--quiet", branch]);
    // Catch up with what the portal saved since; a branch that diverged stays as it is.
    await run(["-C", checkout, "merge", "--ff-only", "--quiet", `origin/${branch}`]).catch(() => undefined);
  } else {
    await run(["-C", checkout, "switch", "--quiet", "--track", "-c", branch, `origin/${branch}`]);
  }
  return true;
}

export interface FileOnBranchOptions {
  /** Switch the checkout itself rather than bring the branch in beside it:
   *  the desktop's checkout is one person's. */
  readonly inPlace?: boolean;
}

/**
 * The absolute path of `file` as it is on `branch`, bringing the branch into
 * the workspace first when no checkout has it. `undefined` when no checkout's
 * `origin` has that branch, or the file is not on it.
 */
export async function fileOnBranch(
  workspace: string,
  branch: string,
  file: string,
  options: FileOnBranchOptions = {},
): Promise<string | undefined> {
  if (!isSafeBranch(branch) || !isSafeRelative(file)) return undefined;
  for (const checkout of checkoutsOf(workspace)) {
    // Already there: a person switched to it, or an earlier open brought it in.
    const current = await run(["-C", checkout, "branch", "--show-current"]).catch(() => "");
    if (current === branch && fs.existsSync(path.join(checkout, file))) return path.join(checkout, file);
    const target = path.join(workspace, worktreeDirName(path.basename(checkout), branch));
    if (options.inPlace) {
      const fetched = await fetchBranch(checkout, branch);
      if (!fetched) continue;
      if (await switchCheckout(checkout, target, branch)) {
        if (fs.existsSync(path.join(checkout, file))) return path.join(checkout, file);
        continue;
      }
    }
    if (fs.existsSync(target)) {
      // Brought in before: catch up with what the portal saved since.
      await run(["-C", target, "pull", "--ff-only", "--quiet"]).catch(() => undefined);
      if (fs.existsSync(path.join(target, file))) return path.join(target, file);
      continue;
    }
    if (!(await fetchBranch(checkout, branch))) continue;
    await run(["-C", checkout, "worktree", "add", "--quiet", "--track", "-B", branch, target, `origin/${branch}`]);
    if (fs.existsSync(path.join(target, file))) return path.join(target, file);
  }
  return undefined;
}

/** A branch Studio saved a product's description on: `product/<id>` or `product/<id>-<digest>`. */
export function isProductBranch(branch: string): boolean {
  return /^product\/[^/].*$/.test(branch);
}

/** The text of `file` at `ref` of `checkout`, as it is (not trimmed); `undefined` when the ref has no such file. */
async function showFile(checkout: string, ref: string, file: string): Promise<string | undefined> {
  try {
    const { stdout } = await git("git", [...LONG_PATHS, "-C", checkout, "show", `${ref}:${file.replace(/\\/g, "/")}`], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * The file differs from what the checkout's HEAD has, and git knows it:
 * somebody edited or staged it here. An untracked copy is one an earlier open
 * wrote, and is brought up to date.
 */
async function editedHere(checkout: string, file: string): Promise<boolean> {
  const status = await run(["-C", checkout, "status", "--porcelain", "--", file]).catch(() => "?");
  return status !== "" && !status.startsWith("??");
}

/**
 * ADR-0053 §4: a product branch lends only its description. The checkout
 * stays on the branch it is on -- its code is current, and a `product/…`
 * branch is a snapshot of the whole repository from the day the description
 * was saved -- and only `file` is brought in from `branch`, written over the
 * checkout's copy. A copy edited here and not committed is left alone: it is
 * the person's, and they are told so by what opens. A checkout an earlier
 * desktop left on the product branch itself is moved back onto the base
 * branch first, when nothing tracked in it is changed. The absolute path of the
 * file in the checkout, or `undefined` when no checkout's `origin` has the
 * branch with that file.
 */
export async function descriptionFromBranch(workspace: string, branch: string, file: string): Promise<string | undefined> {
  if (!isSafeBranch(branch) || !isSafeRelative(file)) return undefined;
  for (const checkout of checkoutsOf(workspace)) {
    const target = path.join(checkout, file);
    const current = await run(["-C", checkout, "branch", "--show-current"]).catch(() => "");
    if (current === branch && !(await leaveProductBranch(checkout)) && fs.existsSync(target)) return target;
    if (!(await fetchBranch(checkout, branch))) continue;
    const text = await showFile(checkout, `refs/remotes/origin/${branch}`, file);
    if (text === undefined) continue;
    if (fs.existsSync(target)) {
      if (fs.readFileSync(target, "utf8") === text) return target;
      if (await editedHere(checkout, file)) return target;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  }
  return undefined;
}

/** Where a file is checked out: the branch, and the main checkout when the file is in a worktree beside it. */
export interface FileCheckout {
  readonly branch: string;
  /** The working tree the file is in. */
  readonly root: string;
  /** The main checkout, when `root` is a linked worktree of it. */
  readonly worktreeOf?: string;
}

/**
 * The branch `file` is on, and whether it is in a linked worktree -- the
 * product brought in beside a checkout that could not be switched. The IDE's
 * Git status shows the main checkout's branch, which is not this one.
 * `undefined` outside a git working tree.
 */
export async function checkoutOfFile(file: string): Promise<FileCheckout | undefined> {
  const dir = path.dirname(file);
  try {
    const root = await run(["-C", dir, "rev-parse", "--show-toplevel"]);
    const branch = (await run(["-C", dir, "branch", "--show-current"])) || "(detached)";
    const gitDir = path.resolve(dir, await run(["-C", dir, "rev-parse", "--git-dir"]));
    const common = path.resolve(dir, await run(["-C", dir, "rev-parse", "--git-common-dir"]));
    const linked = path.normalize(gitDir) !== path.normalize(common);
    return linked ? { branch, root, worktreeOf: path.dirname(common) } : { branch, root };
  } catch {
    return undefined;
  }
}
