import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceRoots } from "../src/roots.ts";

const repos = (...dirs) => (dir) => dirs.includes(dir);

test("a managed workspace yields the checkout, not the container", () => {
  const roots = sourceRoots(
    ["/workspace"],
    ["/workspace/gears-rust/gears/system/api-gateway/gear.gdl", "/workspace/gears-rust/gears/credstore/credstore/gear.gdl"],
    repos("/workspace/gears-rust"),
  );
  assert.deepEqual(roots, ["/workspace/gears-rust"]);
});

test("two checkouts are two roots", () => {
  const roots = sourceRoots(
    ["/workspace"],
    ["/workspace/b/g/gear.gdl", "/workspace/a/x/y/gear.gdl"],
    repos("/workspace/a", "/workspace/b"),
  );
  assert.deepEqual(roots, ["/workspace/a", "/workspace/b"]);
});

test("no repository falls back to the workspace folder", () => {
  assert.deepEqual(sourceRoots(["/w"], ["/w/gears/x/gear.gdl"], repos()), ["/w"]);
});

test("the walk stops at the folder and never leaves it", () => {
  assert.deepEqual(sourceRoots(["/w/inner"], ["/w/inner/x/gear.gdl"], repos("/w")), ["/w/inner"]);
});

test("a description outside every folder is ignored", () => {
  assert.deepEqual(sourceRoots(["/w"], ["/elsewhere/gear.gdl"], repos()), []);
});
