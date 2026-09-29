import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Prewarmer, WARM_FOR_MS, filesToWarm, prewarmRoot, shares, shouldPrewarm } from "./source-prewarm";

function tree(files: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-warm-"));
  for (const file of files) {
    const at = path.join(root, file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, file);
  }
  return root;
}

describe("reading a source root ahead of the engine", () => {
  const made: string[] = [];
  afterAll(() => made.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  it("reads what a catalogue load reads, in the engine's order, and skips what it skips", () => {
    const root = tree([
      "gears/b/gear.gdl",
      "gears/b/Cargo.toml",
      "gears/b/src/lib.rs",
      "gears/a/gear.gdl",
      "gears/a/README.md",
      "target/debug/build.rs",
      ".git/objects/x.rs",
      "ide/node_modules/p/index.rs",
      ".gearbox/shop/dev/main.rs",
    ]);
    made.push(root);
    expect(filesToWarm(root).map((f) => path.relative(root, f).split(path.sep).join("/"))).toEqual([
      "gears/a/gear.gdl",
      "gears/b/Cargo.toml",
      "gears/b/gear.gdl",
      "gears/b/src/lib.rs",
    ]);
  });

  it("gives every worker the front of the tree", () => {
    expect(shares([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 3, 5],
      [2, 4],
    ]);
    expect(shares([1], 8)).toEqual([[1]]);
    expect(shares([], 4)).toEqual([[]]);
  });

  it("reads every file from worker threads", async () => {
    const root = tree(["a/gear.gdl", "a/src/lib.rs", "b/Cargo.toml"]);
    made.push(root);
    await expect(prewarmRoot(root, 2)).resolves.toMatchObject({ root, files: 3 });
  });

  it("is Windows only unless told", () => {
    expect(shouldPrewarm({}, "win32")).toBe(true);
    // The web session runs on Linux: nothing is read there that was not before.
    expect(shouldPrewarm({}, "linux")).toBe(false);
    expect(shouldPrewarm({ GEARBOX_PREWARM: "1" }, "linux")).toBe(true);
    expect(shouldPrewarm({ GEARBOX_PREWARM: "0" }, "win32")).toBe(false);
  });

  it("reads a root once while it is warm, and once for callers asking together", async () => {
    let now = 0;
    const read: string[] = [];
    const warmer = new Prewarmer(async (root) => {
      read.push(root);
      return { root, files: 1, ms: 1 };
    }, () => now);
    const [a, b] = await Promise.all([warmer.prewarm(["/w/x"]), warmer.prewarm(["/w/x"])]);
    expect(read).toHaveLength(1);
    // Reported once, by the caller that started the read.
    expect(a).toHaveLength(1);
    expect(b).toEqual([]);
    expect(await warmer.prewarm(["/w/x"])).toEqual([]);
    now += WARM_FOR_MS;
    await warmer.prewarm(["/w/x"]);
    expect(read).toHaveLength(2);
  });
});
