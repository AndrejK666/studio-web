import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { checkoutOfFile, fileOnBranch, worktreeDirName } from "./product-branch";

const BRANCH = "product/studioweb-77a0da49";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

describe("a product saved on its own branch", () => {
  let scratch: string;
  let workspace: string;
  let checkout: string;
  let besides: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-branch-"));
    // The project's repository: main, and the branch the portal saved
    // product.gdl on.
    const origin = path.join(scratch, "origin");
    fs.mkdirSync(origin);
    sh(origin, "init", "--quiet", "-b", "main");
    fs.writeFileSync(path.join(origin, "README.md"), "studio-web");
    sh(origin, "add", ".");
    sh(origin, "commit", "--quiet", "-m", "start");
    sh(origin, "switch", "--quiet", "-c", BRANCH);
    fs.writeFileSync(path.join(origin, "product.gdl"), "product studioweb {}");
    sh(origin, "add", ".");
    sh(origin, "commit", "--quiet", "-m", "product");
    sh(origin, "switch", "--quiet", "main");
    // The workspace's checkout of it, on main.
    workspace = path.join(scratch, "workspace");
    fs.mkdirSync(workspace);
    sh(workspace, "clone", "--quiet", origin, "studio-web");
    checkout = path.join(workspace, "studio-web");
    besides = path.join(workspace, worktreeDirName("studio-web", BRANCH));
  });

  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("is brought in beside a session's checkout, which stays where it is", async () => {
    const file = await fileOnBranch(workspace, BRANCH, "product.gdl");
    expect(file).toBe(path.join(besides, "product.gdl"));
    expect(sh(checkout, "branch", "--show-current")).toBe("main");
  });

  it("switches a desktop's checkout, which can then move off it and back", async () => {
    const file = await fileOnBranch(workspace, BRANCH, "product.gdl", { inPlace: true });
    expect(file).toBe(path.join(checkout, "product.gdl"));
    expect(sh(checkout, "branch", "--show-current")).toBe(BRANCH);
    expect(fs.existsSync(besides)).toBe(false);
    sh(checkout, "switch", "--quiet", "main");
    sh(checkout, "switch", "--quiet", BRANCH);
    expect(sh(checkout, "branch", "--show-current")).toBe(BRANCH);
  });

  it("takes away the worktree an earlier open left, which held the branch", async () => {
    await fileOnBranch(workspace, BRANCH, "product.gdl");
    expect(fs.existsSync(besides)).toBe(true);
    const file = await fileOnBranch(workspace, BRANCH, "product.gdl", { inPlace: true });
    expect(file).toBe(path.join(checkout, "product.gdl"));
    expect(fs.existsSync(besides)).toBe(false);
    expect(sh(checkout, "branch", "--show-current")).toBe(BRANCH);
  });

  it("says which branch a file is on, and which checkout its worktree is beside", async () => {
    fs.writeFileSync(path.join(checkout, "README.md"), "edited");
    const file = await fileOnBranch(workspace, BRANCH, "product.gdl", { inPlace: true });
    const there = await checkoutOfFile(file as string);
    expect(there?.branch).toBe(BRANCH);
    // One spelling of a path for both sides: Windows hands out 8.3 short names.
    expect(fs.realpathSync.native(there?.worktreeOf as string)).toBe(fs.realpathSync.native(checkout));
    const main = await checkoutOfFile(path.join(checkout, "README.md"));
    expect(main?.branch).toBe("main");
    expect(main?.worktreeOf).toBeUndefined();
    expect(await checkoutOfFile(path.join(scratch, "nowhere.gdl"))).toBeUndefined();
  });

  it("leaves a desktop's checkout with uncommitted work alone", async () => {
    fs.writeFileSync(path.join(checkout, "README.md"), "edited");
    const file = await fileOnBranch(workspace, BRANCH, "product.gdl", { inPlace: true });
    expect(file).toBe(path.join(besides, "product.gdl"));
    expect(sh(checkout, "branch", "--show-current")).toBe("main");
    expect(fs.readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("edited");
  });
});
