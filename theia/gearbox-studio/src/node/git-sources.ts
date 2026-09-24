// Constructor Studio: a product's git source, brought into the workspace.
//
// A description Studio writes names its corpus as a git source at the commit it
// was checked against -- `source(id = "gears-rust", at = git(url, rev))` -- so
// it says by itself what it was built from. The engine takes source roots as
// directories and names each after its directory, so opening such a product
// needs that commit on disk, in a directory called by the source's id.
//
// A checkout the session already has is used when it is that repository at
// that commit. Otherwise the commit is brought in under `.gearbox/sources/`:
// as a worktree of a checkout of the same repository when there is one (no
// second download), or as a clone. Never by moving a checkout somebody may
// have open.

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const git = promisify(execFile);

export interface GitRef {
  readonly rev?: string | null;
  readonly tag?: string | null;
  readonly branch?: string | null;
}

/** A source id the engine accepts, which is also a safe directory name. */
export function isKebabId(id: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id);
}

/** A ref this passes to git: nothing that reads as an option or climbs. */
export function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

/** A remote git may be asked to fetch: https or ssh-style, never an option. */
export function isSafeUrl(url: string): boolean {
  return /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(url);
}

/** `https://github.com/Owner/Repo.git`, `git@github.com:owner/repo` -> `github.com/owner/repo`. */
export function remoteKey(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** The one ref asked for, rev first: a rev is exact, a branch moves. */
export function pickRef(ref: GitRef): string | undefined {
  const r = ref.rev ?? ref.tag ?? ref.branch ?? undefined;
  return r !== undefined && r !== null && isSafeRef(r) ? r : undefined;
}

/** `.gearbox/sources/<ref>/<id>`, the ref shortened when it is a commit. */
export function materializedDir(workspace: string, id: string, ref: string): string {
  const key = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref.replace(/\//g, "-");
  return path.join(workspace, ".gearbox", "sources", key, id);
}

async function run(args: string[]): Promise<string> {
  const { stdout } = await git("git", args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function commitOf(dir: string, ref: string): Promise<string | undefined> {
  return run(["-C", dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => undefined);
}

function checkoutsOf(workspace: string): string[] {
  try {
    return fs
      .readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(workspace, e.name))
      .filter((d) => fs.existsSync(path.join(d, ".git")));
  } catch {
    return [];
  }
}

/**
 * A directory named `id` holding `url` at `ref`, or `undefined` when it cannot
 * be had (bad input, the repository unreachable, the ref unknown).
 */
export async function materializeGitSource(
  workspace: string,
  id: string,
  url: string,
  ref: GitRef,
): Promise<string | undefined> {
  const want = pickRef(ref);
  if (!isKebabId(id) || !isSafeUrl(url) || want === undefined) return undefined;

  const same: string[] = [];
  for (const dir of checkoutsOf(workspace)) {
    // The configured URL, not `remote get-url`'s: that one applies `insteadOf`
    // rewrites, and two spellings of one repository must compare as written.
    const origin = await run(["-C", dir, "config", "--get", "remote.origin.url"]).catch(() => "");
    if (origin !== "" && remoteKey(origin) === remoteKey(url)) same.push(dir);
  }

  // A checkout already there, at that commit, under the source's own name.
  for (const dir of same) {
    if (path.basename(dir) !== id) continue;
    const head = await commitOf(dir, "HEAD");
    const target = await commitOf(dir, want);
    if (head !== undefined && head === target) return dir;
  }

  const target = materializedDir(workspace, id, want);
  if (fs.existsSync(path.join(target, ".git"))) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const donor = same[0];
  if (donor !== undefined) {
    // No second download: fetch the one ref into the checkout we have, and
    // give it its own directory.
    await run(["-C", donor, "fetch", "--quiet", "origin", want]).catch(() => undefined);
    const commit = (await commitOf(donor, want)) ?? (await commitOf(donor, "FETCH_HEAD"));
    if (commit !== undefined) {
      await run(["-C", donor, "worktree", "add", "--quiet", "--detach", target, commit]);
      return target;
    }
  }
  await run(["clone", "--quiet", "--filter=blob:none", url, target]);
  await run(["-C", target, "checkout", "--quiet", "--detach", ref.rev ?? ref.tag ?? `origin/${want}`]);
  return target;
}
