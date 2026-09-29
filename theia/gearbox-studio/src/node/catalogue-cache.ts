// Constructor Studio: a catalogue load, remembered -- in this process for the
// engine that did it, and on disk beside the corpus copy it was read from.
//
// **Why remember it at all.** A load parses every gear crate in the corpus, and
// the engine answers one request at a time, so everything an open asks waits for
// it: 7-8 s with Defender's verdicts cached, a minute and more without (see
// `source-prewarm.ts`). An open respawned the engine twice and read the whole
// corpus again even when the engine already running had read exactly those roots
// a moment before. Two things follow, and this file is both:
//
// - **In this process** (`LoadRecord`): the load the running engine did, as it
//   arrived. When an open asks for the same roots again the engine is kept -- its
//   catalogue is still in its memory, which is what `product/load` and `resolve`
//   read -- and the frontend is answered from the record rather than by a rescan.
//
// - **On disk** (`readCatalogueCache` / `writeCatalogueCache`): the same record,
//   for the next launch. The engine has no way to be handed a projection (no
//   `catalogue/load` parameter, no warm-start file at 55f7015; asked for in
//   https://github.com/MikeFalcon77/gearbox/issues/5), so a new engine
//   still loads; the file lets the Catalogue show every gear, projected, the
//   moment the load's first answer arrives instead of as the projection crawls.
//
// **Only for a corpus copy at a commit**: `<cache>/<host__owner__repo>/<commit>/<id>`
// under `corpusCacheRoot()`, the per-machine copy Studio keeps and nobody edits.
// A commit never changes, so what was read from it is still true; a workspace's
// own checkout changes under a person's hands and is always read again. The key
// is the commit of every root and the engine binary that read them, so a new
// commit or a new engine is a different file, never a stale answer.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { CatalogueDiagnostics } from "../common/generated/CatalogueDiagnostics";
import type { CatalogueLoadResult } from "../common/generated/CatalogueLoadResult";
import type { Diagnostic } from "../common/generated/Diagnostic";
import type { ProgressParams } from "../common/generated/ProgressParams";
import type { GearboxClient } from "../common/protocol";

/** Bumped when the file's shape changes: an older file is then a miss, not a parse error. */
export const CACHE_FORMAT = 1;

/** What a cached catalogue is keyed by. Equal keys mean the same load would come out. */
export interface CatalogueCacheKey {
  readonly format: number;
  /** The engine binary that read the roots: its path, size and modification time. */
  readonly engine: string;
  /** Every root, in the engine's order, with the commit it is at. */
  readonly roots: ReadonlyArray<{ readonly path: string; readonly commit: string }>;
}

/** One finished load, as the frontend was sent it. */
export interface RecordedCatalogue {
  readonly load: CatalogueLoadResult;
  /** Every projection, the last one per row, in the order they arrived. */
  readonly changed: readonly CatalogueChanged[];
  /** What the second pass reported after the load answered. */
  readonly diagnostics: readonly Diagnostic[];
  readonly completed: number;
  readonly total: number;
}

/**
 * One root as a comparable string: no `\\?\` prefix, absolute, one separator,
 * and case-folded where the file system is (Windows). The engine reports roots
 * canonicalized and a description spells them as written, so `C:/x` and
 * `\\?\C:\x` must compare equal.
 */
export function normalizeRoot(root: string, platform: NodeJS.Platform = process.platform): string {
  let p = root.startsWith("\\\\?\\") ? root.slice(4) : root;
  if (platform === "win32") {
    p = path.win32.resolve(p.replace(/\//g, "\\")).replace(/\\+$/, "");
    return p.toLowerCase();
  }
  return path.posix.resolve(p).replace(/\/+$/, "") || "/";
}

/** Whether two root lists are the same roots in the same order. */
export function sameRoots(a: readonly string[], b: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  return a.length === b.length && a.every((root, i) => normalizeRoot(root, platform) === normalizeRoot(b[i]!, platform));
}

/**
 * The commit a corpus copy is at, when `root` is one: `<cacheRoot>/<repo>/<commit12>/<id>`
 * whose `.git/HEAD` is detached at a commit starting with that directory's name.
 * Read from the file rather than asked of git, which on Windows costs a process.
 */
export function corpusCommitOf(root: string, cacheRoot: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const at = normalizeRoot(root, platform);
  const base = normalizeRoot(cacheRoot, platform);
  const sep = platform === "win32" ? "\\" : "/";
  if (!at.startsWith(base + sep)) return undefined;
  const parts = at.slice(base.length + 1).split(sep);
  if (parts.length !== 3) return undefined;
  const [, short] = parts as [string, string, string];
  let head: string;
  try {
    head = fs.readFileSync(path.join(root.startsWith("\\\\?\\") ? root.slice(4) : root, ".git", "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  return /^[0-9a-f]{40}$/.test(head) && head.startsWith(short) ? head : undefined;
}

/**
 * The engine binary `command` names, as a statement of which build it is: the
 * resolved path, its size and modification time. Every engine pin reports
 * version `0.1.0`, so `--version` cannot tell two pins apart; the file can.
 */
export function engineIdentity(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = resolveExecutable(command, env);
  if (file === undefined) return undefined;
  try {
    const stat = fs.statSync(file);
    return `${file}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/** `command` as the file `spawn` would run: itself when it is a path, else the first match on `PATH`. */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command) ? path.resolve(command) : undefined;
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this one.
    }
  }
  return undefined;
}

/**
 * The key for a load of `roots` by `engine`, or `undefined` when any root is
 * not a corpus copy at a commit -- that load is not one to remember.
 */
export function catalogueCacheKey(
  roots: readonly string[],
  cacheRoot: string,
  engine: string | undefined,
  platform: NodeJS.Platform = process.platform,
): CatalogueCacheKey | undefined {
  if (engine === undefined || roots.length === 0) return undefined;
  const keyed: Array<{ path: string; commit: string }> = [];
  for (const root of roots) {
    const commit = corpusCommitOf(root, cacheRoot, platform);
    if (commit === undefined) return undefined;
    keyed.push({ path: normalizeRoot(root, platform), commit });
  }
  return { format: CACHE_FORMAT, engine, roots: keyed };
}

/**
 * Where a key's catalogue lives: `.catalogue/<digest>.json` in the commit
 * directory of its first root, beside the copy it was read from. Not inside the
 * copy -- that is the source root, and the engine would walk it -- and not a
 * kebab-case directory, so `cachedCorpora` never takes it for a copy.
 */
export function catalogueCacheFile(firstRoot: string, key: CatalogueCacheKey): string {
  const digest = createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 24);
  const plain = firstRoot.startsWith("\\\\?\\") ? firstRoot.slice(4) : firstRoot;
  return path.join(path.dirname(path.resolve(plain)), ".catalogue", `${digest}.json`);
}

/**
 * The catalogue remembered for `key`, or `undefined`: no file, another key's
 * file, an older format, or anything that does not read as one. A cache is
 * never a reason for an open to fail.
 */
export function readCatalogueCache(file: string, key: CatalogueCacheKey): RecordedCatalogue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { key: stored, catalogue } = parsed as { key?: unknown; catalogue?: unknown };
  if (JSON.stringify(stored) !== JSON.stringify(key)) return undefined;
  return isRecordedCatalogue(catalogue) ? catalogue : undefined;
}

/** Write `catalogue` for `key`, whole or not at all: to a temporary file, then renamed. */
export function writeCatalogueCache(file: string, key: CatalogueCacheKey, catalogue: RecordedCatalogue): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFileSync(partial, JSON.stringify({ key, catalogue }));
  fs.renameSync(partial, file);
}

function isRecordedCatalogue(value: unknown): value is RecordedCatalogue {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Record<keyof RecordedCatalogue, unknown>>;
  const load = v.load as Partial<CatalogueLoadResult> | undefined;
  return (
    typeof load === "object" &&
    load !== null &&
    typeof load.total === "number" &&
    Array.isArray(load.pending) &&
    Array.isArray(load.diagnostics) &&
    Array.isArray(v.changed) &&
    v.changed.every(
      (c: unknown) =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as CatalogueChanged).replaces === "string" &&
        typeof (c as CatalogueChanged).gear === "object" &&
        (c as CatalogueChanged).gear !== null &&
        typeof (c as CatalogueChanged).gear.source === "string",
    ) &&
    Array.isArray(v.diagnostics) &&
    typeof v.completed === "number" &&
    typeof v.total === "number"
  );
}

/**
 * One engine's catalogue load, recorded as the frontend is sent it.
 *
 * Complete only when the engine's `$/progress done` arrived: a load the engine
 * died in, or one a respawn cut short, is missing gears, and answering from it
 * would be the tree-with-holes a stopped load is.
 */
export class LoadRecord {
  protected result: CatalogueLoadResult | undefined;
  protected readonly changedByRow = new Map<string, CatalogueChanged>();
  protected readonly later: Diagnostic[] = [];
  protected completedCount = 0;
  protected totalCount = 0;
  protected state: "streaming" | "done" | "failed" = "streaming";
  protected settle!: () => void;
  /** Resolves when the load finished or failed. */
  readonly settled: Promise<void> = new Promise((resolve) => (this.settle = resolve));

  get complete(): boolean {
    return this.state === "done" && this.result !== undefined;
  }

  get streaming(): boolean {
    return this.state === "streaming";
  }

  /** `done` came before the answer was handed to `answered` (they can race on one tick). */
  protected doneSeen = false;

  answered(result: CatalogueLoadResult): void {
    if (this.state !== "streaming") return;
    this.result = result;
    if (!this.doneSeen) this.totalCount = result.total;
    // Nothing to project is a load that is finished with its answer.
    if (this.doneSeen || (result.total === 0 && result.pending.length === 0)) this.finish("done");
  }

  changed(event: CatalogueChanged): void {
    if (this.state !== "streaming") return;
    const row = `${event.gear.source}\u0000${event.replaces}`;
    // Re-set rather than updated in place, so the order stays the arrival order
    // of each row's last word -- a plugin's join lands after its projection.
    this.changedByRow.delete(row);
    this.changedByRow.set(row, event);
  }

  diagnostics(event: CatalogueDiagnostics): void {
    if (this.state !== "streaming") return;
    this.later.push(...event.diagnostics);
  }

  progress(event: ProgressParams): void {
    if (this.state !== "streaming") return;
    this.completedCount = event.completed;
    this.totalCount = event.total;
    if (!event.done) return;
    if (this.result === undefined) this.doneSeen = true;
    else this.finish("done");
  }

  fail(): void {
    this.finish("failed");
  }

  /** The finished load, or `undefined` while it is not one. */
  snapshot(): RecordedCatalogue | undefined {
    if (!this.complete || this.result === undefined) return undefined;
    return {
      load: this.result,
      changed: [...this.changedByRow.values()],
      diagnostics: [...this.later],
      completed: this.completedCount,
      total: this.totalCount,
    };
  }

  protected finish(state: "done" | "failed"): void {
    if (this.state !== "streaming") return;
    this.state = state;
    this.settle();
  }
}

/**
 * Tell `client` a recorded load again, in the order the engine told it: every
 * projection, the second pass's diagnostics, then `done`. For after
 * `loadCatalogue` has answered with `recorded.load`.
 */
export function replayCatalogue(recorded: RecordedCatalogue, client: Pick<GearboxClient, "onCatalogueChanged" | "onCatalogueDiagnostics" | "onProgress">): void {
  for (const event of recorded.changed) client.onCatalogueChanged(event);
  if (recorded.diagnostics.length > 0) client.onCatalogueDiagnostics({ diagnostics: [...recorded.diagnostics] });
  client.onProgress({ token: "catalogue", completed: recorded.completed, total: recorded.total, done: true });
}
