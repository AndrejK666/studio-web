// The warm start, through `GearboxServiceImpl` itself over a scripted engine:
// an open on the roots the running engine already read keeps it and is told the
// load again; anything else respawns and reads, as before.
import "reflect-metadata";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { GearboxClient } from "../common/protocol";

type Handler = (params: unknown) => void;

/** One scripted engine: answers `initialize` and `catalogue/load`, and projects when told to. */
class FakeEngine {
  readonly calls: string[] = [];
  readonly handlers = new Map<string, Handler>();
  dead = false;
  exited = new Promise<string>(() => undefined);
  protected finishLoad: (() => void) | undefined;
  protected queue: Promise<unknown> = Promise.resolve();
  constructor(readonly roots: readonly string[]) {}

  readonly connection = {
    onNotification: (name: string, handler: Handler) => void this.handlers.set(name, handler),
    sendNotification: async () => undefined,
  };

  /** One request at a time, as the engine answers them. */
  request<T>(name: string, params: unknown): Promise<T> {
    this.calls.push(name);
    const answer = this.queue.then(() => this.answer(name, params));
    this.queue = answer.then(
      () => this.loadDone,
      () => undefined,
    );
    return answer as Promise<T>;
  }

  protected loadDone: Promise<void> = Promise.resolve();

  protected answer(name: string, params: unknown): unknown {
    if (name === "initialize") {
      return { server_info: { name: "gearbox", version: "0.1.0" }, capabilities: {}, roots: this.roots.map((p) => ({ id: "gears-rust", path: p })), params };
    }
    if (name === "gearbox/catalogue/load") {
      // Answered at S1; projections follow, and the engine reads nothing else until they end.
      this.loadDone = new Promise((resolve) => (this.finishLoad = resolve));
      return {
        total: 2,
        pending: [
          { source: "gears-rust", gdl_path: "gears/a/gear.gdl" },
          { source: "gears-rust", gdl_path: "gears/b/gear.gdl" },
        ],
        diagnostics: [],
      };
    }
    return { ok: true };
  }

  /** The rest of the load: two projections and `done`. */
  project(): void {
    const changed = (gdl: string, id: string): CatalogueChanged => ({ gear: { id, source: "gears-rust", gdl_path: gdl } as never, replaces: gdl });
    this.handlers.get("gearbox/catalogueChanged")?.(changed("gears/a/gear.gdl", "a"));
    this.handlers.get("gearbox/catalogueChanged")?.(changed("gears/b/gear.gdl", "b"));
    this.handlers.get("$/progress")?.({ token: "catalogue", completed: 2, total: 2, done: true });
    this.finishLoad?.();
  }

  dispose(): void {
    this.dead = true;
  }
}

const spawned: FakeEngine[] = [];
jest.mock("./gearbox-engine-process", () => ({
  spawnEngine: (_engine: string, roots: string[]) => {
    const engine = new FakeEngine(roots);
    spawned.push(engine);
    return engine;
  },
}));

// eslint-disable-next-line import/first
import { GearboxServiceImpl } from "./gearbox-service-impl";

const COMMIT = "a0a42cec5e68b313c31e3ceb00254b0df89cd8b8";

function client(): GearboxClient & { told: string[] } {
  const told: string[] = [];
  return {
    told,
    onCatalogueChanged: (e) => told.push(`changed ${e.gear.id}`),
    onCatalogueDiagnostics: () => told.push("diagnostics"),
    onProgress: (e) => told.push(`progress ${e.done === true ? "done" : e.completed}`),
    onLog: () => undefined,
    onEngineExit: () => told.push("exit"),
    onDocumentDiagnostics: () => undefined,
  } as GearboxClient & { told: string[] };
}

function service(): GearboxServiceImpl & { client: ReturnType<typeof client> } {
  const s = new GearboxServiceImpl();
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  Object.assign(s, { logger });
  const c = client();
  s.setClient(c);
  return Object.assign(s, { client: c });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("keeping the engine for an open on the same roots", () => {
  let dir: string;
  let copy: string;
  let checkout: string;
  const env = { ...process.env };
  beforeEach(() => {
    spawned.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-keep-"));
    const cache = path.join(dir, "corpus");
    copy = path.join(cache, "github.com__o__gears-rust", COMMIT.slice(0, 12), "gears-rust");
    fs.mkdirSync(path.join(copy, ".git"), { recursive: true });
    fs.writeFileSync(path.join(copy, ".git", "HEAD"), COMMIT);
    checkout = path.join(dir, "ws", "gears-rust");
    fs.mkdirSync(checkout, { recursive: true });
    const engine = path.join(dir, "gearbox-bin");
    fs.writeFileSync(engine, "x");
    process.env.STUDIO_CORPUS_CACHE = cache;
    process.env.GEARBOX_ENGINE = engine;
    process.env.GEARBOX_PREWARM = "0";
  });
  afterEach(() => {
    process.env = { ...env };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function loadedOnce(s: ReturnType<typeof service>, roots: string[]): Promise<void> {
    await s.initialize({ roots, workspace: dir });
    await s.loadCatalogue();
    spawned[spawned.length - 1]!.project();
    await tick();
  }

  it("keeps a corpus copy's engine and tells the last load again, without a rescan", async () => {
    const s = service();
    await loadedOnce(s, [copy]);
    s.client.told.length = 0;

    const init = await s.initialize({ roots: [copy.replace(/\\/g, "/")], workspace: path.join(dir, "ws") }, true);
    expect(init.reused).toBe(true);
    expect(spawned).toHaveLength(1);
    const load = await s.loadCatalogue();
    await tick();
    expect(load.pending.map((p) => p.gdl_path)).toEqual(["gears/a/gear.gdl", "gears/b/gear.gdl"]);
    expect(s.client.told).toEqual(["changed a", "changed b", "progress done"]);
    // One `catalogue/load` in all: the second answer came from the record. The
    // kept engine was told the new workspace, without roots, so it keeps its catalogue.
    const engine = spawned[0]!;
    expect(engine.calls.filter((c) => c === "gearbox/catalogue/load")).toHaveLength(1);
    expect(engine.calls.filter((c) => c === "initialize")).toHaveLength(2);
  });

  it("waits for a load in flight instead of cutting it short, and tells it once it ends", async () => {
    const s = service();
    await s.initialize({ roots: [copy], workspace: dir });
    await s.loadCatalogue();
    s.client.told.length = 0;
    // Mid-projection: the open's first step asks to keep the engine.
    const init = await s.initialize({ roots: [copy], workspace: dir }, true);
    expect(init.reused).toBe(true);
    const product = s.loadProduct(path.join(dir, "product.gdl"));
    const load = s.loadCatalogue();
    await tick();
    // Nothing is sent to the engine ahead of its new workspace, which waits behind the load.
    expect(spawned[0]!.calls).toEqual(["initialize", "gearbox/catalogue/load"]);
    spawned[0]!.project();
    await product;
    await load;
    await tick();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.calls).toEqual(["initialize", "gearbox/catalogue/load", "initialize", "gearbox/product/load"]);
    // The live projections reached the client, then the told-again load for the second answer.
    expect(s.client.told).toEqual(["changed a", "changed b", "progress done", "changed a", "changed b", "progress done"]);
  });

  it("respawns and reads again when not asked to keep, or for a workspace's own checkout", async () => {
    const s = service();
    await loadedOnce(s, [copy]);
    // `Reload Catalogue`: no `keep`.
    expect((await s.initialize({ roots: [copy], workspace: dir })).reused).toBeUndefined();
    expect(spawned).toHaveLength(2);

    const t = service();
    spawned.length = 0;
    await loadedOnce(t, [checkout]);
    expect((await t.initialize({ roots: [checkout], workspace: dir }, true)).reused).toBeUndefined();
    expect(spawned).toHaveLength(2);
  });

  it("respawns for other roots", async () => {
    const s = service();
    await loadedOnce(s, [copy]);
    expect((await s.initialize({ roots: [copy, checkout], workspace: dir }, true)).reused).toBeUndefined();
    expect(spawned).toHaveLength(2);
  });

  it("answers the next process's first load with the projections cached beside the copy", async () => {
    const first = service();
    await loadedOnce(first, [copy]);
    expect(fs.readdirSync(path.join(path.dirname(copy), ".catalogue"))).toHaveLength(1);

    // The app restarted: a new service, a new engine, and the file.
    const second = service();
    await second.initialize({ roots: [copy], workspace: dir });
    const load = await second.loadCatalogue();
    expect(load.cached?.map((c) => c.gear.id)).toEqual(["a", "b"]);
    // Still a real load: the engine is what `product/load` and `resolve` read.
    expect(spawned[spawned.length - 1]!.calls).toContain("gearbox/catalogue/load");
  });

  it("caches nothing for a workspace's own checkout", async () => {
    const s = service();
    await loadedOnce(s, [checkout]);
    expect(fs.existsSync(path.join(path.dirname(checkout), ".catalogue"))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(copy), ".catalogue"))).toBe(false);
  });
});
