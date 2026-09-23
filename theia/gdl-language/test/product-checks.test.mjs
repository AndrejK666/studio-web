import assert from "node:assert/strict";
import { test } from "node:test";

import { isProductFile, productFindings } from "../src/product-checks.ts";

const at = (line, character = 8) => ({
  uri: "file:///workspace/shop/product.gdl",
  range: { start: { line, character }, end: { line, character: character + 10 } },
});

test("validate and resolve are merged, and a finding both report is shown once", () => {
  const unknown = { code: "GBX0301", severity: "error", message: "names a gear no source declares", location: at(27), help: "run `gearbox catalogue`" };
  const orphan = { code: "GBX0513", severity: "error", message: "no selected gear expects it", location: at(26) };
  const grpc = { code: "GBX0315", severity: "warning", message: "grpc-hub and no gear", location: at(0, 0) };
  const f = productFindings("file:///fallback", [unknown, orphan], [unknown, grpc]);
  assert.deepEqual(f.map((x) => [x.code, x.severity, x.range.start.line]), [
    ["GBX0301", "error", 27],
    ["GBX0513", "error", 26],
    ["GBX0315", "warning", 0],
  ]);
  assert.equal(f[0].message, "names a gear no source declares\nrun `gearbox catalogue`");
});

test("a finding with no location lands on the file asked about, severity normalised", () => {
  const f = productFindings("file:///w/product.gdl", [{ code: "GBX0401", severity: "note", message: "m" }]);
  assert.equal(f[0].uri, "file:///w/product.gdl");
  assert.equal(f[0].severity, "info");
  assert.deepEqual(f[0].range.start, { line: 0, character: 0 });
});

test("only product.gdl is a product description", () => {
  assert.ok(isProductFile("/workspace/shop/product.gdl"));
  assert.ok(isProductFile("C:\\w\\product.gdl"));
  assert.ok(!isProductFile("/workspace/gears-rust/gears/x/gear.gdl"));
  assert.ok(!isProductFile("/w/my-product.gdl"));
});
