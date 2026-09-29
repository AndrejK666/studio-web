// Constructor Studio: read a source root's files in parallel before the engine
// reads them one at a time.
//
// **Where a cold open's time went on Windows, measured.** The engine's catalogue
// load parses every gear crate in the corpus -- about 4,200 `.rs`, `Cargo.toml`
// and `gear.gdl` files -- on one thread, opening them one after another. With
// real-time antivirus scanning (Microsoft Defender), every first open of a file
// waits for its scan, so the engine waited for 4,200 scans in a row: 71 s wall
// for 8.7 s of its own CPU on the member's corpus copy, 143 s of Defender CPU
// alongside. A second load is 7 s, because Defender remembers the verdicts --
// until it forgets them, which is why the first open after a launch is slow.
//
// Reading the same files from 32 threads first costs 7-11 s cold (Defender scans
// in parallel) and about 1 s once the verdicts are cached, and the engine's load
// after it is back to its 7-8 s. So this runs beside the engine's load: it keeps
// ahead of the engine's sequential reads, and each file the engine then opens
// has been scanned already.
//
// Worker threads with synchronous reads, not `fs.promises`: the promise API runs
// on libuv's pool, four threads unless `UV_THREADPOOL_SIZE` was set before the
// process started, and that measured 24 s cold instead of 7. The workers' code
// is inline because the backend is bundled, and a script file beside this one
// would not be where a path computed here says.
//
// Windows only by default (`shouldPrewarm`): the web session and a Linux or
// macOS desktop have no on-access scanner in the way, and the page cache does
// what this would. The web session therefore reads nothing more than before.
//
// The fix belongs in the engine -- reading the crates in parallel, or not
// re-parsing an unchanged corpus: https://github.com/MikeFalcon77/gearbox/issues/5.
// Remove this with the pin that does either.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Worker } from "worker_threads";

/** What the engine never descends into: `SKIP_DIRS` in `gearbox-engine`'s `catalogue.rs`. */
const SKIP_DIRS = new Set(["target", "node_modules", ".git", ".gearbox"]);

/** The files a catalogue load reads: descriptions, manifests and Rust sources. */
const READ_BY_THE_ENGINE = /\.(rs|toml|gdl)$/;

/** How long a root counts as warm in this process: well inside a Defender verdict's life. */
export const WARM_FOR_MS = 10 * 60_000;

/**
 * Whether to read ahead of the engine here. `GEARBOX_PREWARM=1` or `0` decides
 * when set (tests, and anyone measuring); otherwise Windows only.
 */
export function shouldPrewarm(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const set = env.GEARBOX_PREWARM?.trim();
  if (set === "1") return true;
  if (set === "0") return false;
  return platform === "win32";
}

/**
 * Every file under `root` a catalogue load reads, in the order the engine meets
 * them: a sorted walk, as the engine's discovery is sorted.
 */
export function filesToWarm(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && READ_BY_THE_ENGINE.test(entry.name)) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found;
}

/** Split `files` round-robin, so every worker starts at the front of the tree. */
export function shares<T>(files: readonly T[], workers: number): T[][] {
  const n = Math.max(1, Math.min(workers, files.length));
  const out: T[][] = Array.from({ length: n }, () => []);
  files.forEach((file, index) => out[index % n]!.push(file));
  return out;
}

export interface PrewarmResult {
  readonly root: string;
  readonly files: number;
  readonly ms: number;
}

// Runs in each worker: read every file named, synchronously, and say how many.
const WORKER_SOURCE = `
const { workerData, parentPort } = require("worker_threads");
const fs = require("fs");
let read = 0;
for (const file of workerData) {
  try { fs.readFileSync(file); read++; } catch {}
}
parentPort.postMessage(read);
`;

/**
 * Read every file under `root` that a catalogue load reads, from `workers`
 * threads. Resolves when all are read (never rejects: a file that cannot be read
 * here is one the engine reports itself).
 */
export async function prewarmRoot(root: string, workers = defaultWorkers()): Promise<PrewarmResult> {
  const started = Date.now();
  const files = filesToWarm(root);
  const counts = await Promise.all(
    shares(files, workers).map(
      (share) =>
        new Promise<number>((resolve) => {
          let worker: Worker;
          try {
            worker = new Worker(WORKER_SOURCE, { eval: true, workerData: share });
          } catch {
            resolve(0);
            return;
          }
          worker.once("message", (read: number) => resolve(read));
          worker.once("error", () => resolve(0));
          worker.once("exit", () => resolve(0));
        }),
    ),
  );
  return { root, files: counts.reduce((a, b) => a + b, 0), ms: Date.now() - started };
}

/** As many threads as the machine has, up to 32: the most measured to help. */
export function defaultWorkers(): number {
  return Math.max(4, Math.min(32, os.cpus().length));
}

/**
 * The roots read ahead in this process, and when: a root warmed a minute ago is
 * not read again for every engine an open respawns.
 */
export class Prewarmer {
  protected readonly warmedAt = new Map<string, number>();
  protected readonly inFlight = new Map<string, Promise<PrewarmResult | undefined>>();

  constructor(
    protected readonly warm: (root: string) => Promise<PrewarmResult> = (root) => prewarmRoot(root),
    protected readonly now: () => number = Date.now,
  ) {}

  /** Read `roots` ahead, each at most once per `WARM_FOR_MS`; the results of the roots actually read. */
  async prewarm(roots: readonly string[]): Promise<PrewarmResult[]> {
    const results = await Promise.all(roots.map((root) => this.one(root)));
    return results.filter((r): r is PrewarmResult => r !== undefined);
  }

  protected one(root: string): Promise<PrewarmResult | undefined> {
    const key = path.resolve(root);
    // A caller that joins a read in flight waits for it and reports nothing:
    // the one that started it reports it.
    const running = this.inFlight.get(key);
    if (running !== undefined) return running.then(() => undefined);
    const at = this.warmedAt.get(key);
    if (at !== undefined && this.now() - at < WARM_FOR_MS) return Promise.resolve(undefined);
    const started = this.warm(key).then(
      (result) => {
        this.warmedAt.set(key, this.now());
        return result;
      },
      () => undefined,
    );
    const tracked = started.finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, tracked);
    return tracked;
  }
}
