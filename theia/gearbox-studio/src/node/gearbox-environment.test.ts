import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { pathToFileURL } from "url";

import { folderOfWorkspaceUri, gearboxEnabled, productFiles } from "./gearbox-environment";

function tree(files: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-products-"));
  for (const file of files) {
    const at = path.join(root, file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, "");
  }
  return root;
}

function found(root: string): string[] {
  return productFiles(root).map((file) => path.relative(root, file).split(path.sep).join("/"));
}

describe("productFiles", () => {
  const made: string[] = [];
  const make = (files: readonly string[]) => {
    const root = tree(files);
    made.push(root);
    return root;
  };
  afterAll(() => made.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  it("finds a product New Product puts under the repository the member opened", () => {
    // The desktop member opened studio-web itself: the workspace is the checkout.
    const root = make([".git/HEAD", "products/shop/product.gdl", "products/blog/product.gdl", "src/main.ts"]);
    expect(found(root)).toEqual(["products/blog/product.gdl", "products/shop/product.gdl"]);
  });

  it("still finds the portal's product at the workspace root", () => {
    const root = make([".git/HEAD", "product.gdl"]);
    expect(found(root)).toEqual(["product.gdl"]);
  });

  it("still finds each checkout's products in a workspace of checkouts", () => {
    const root = make([
      "gears-rust/gears/authn/gear.gdl",
      "payments/product.gdl",
      "gearbox/products/payments-demo/product.gdl",
    ]);
    expect(found(root)).toEqual(["gearbox/products/payments-demo/product.gdl", "payments/product.gdl"]);
  });

  it("finds both layouts at once, each file once", () => {
    const root = make(["products/own/product.gdl", "shop/product.gdl", "shop/products/b/product.gdl"]);
    expect(found(root)).toEqual(["products/own/product.gdl", "shop/product.gdl", "shop/products/b/product.gdl"]);
  });

  it("does not descend into hidden or build directories", () => {
    const root = make([".gearbox/products/x/product.gdl", "node_modules/products/y/product.gdl", "target/product.gdl"]);
    expect(found(root)).toEqual([]);
  });

  it("answers nothing for a folder that is not there", () => {
    expect(productFiles(path.join(os.tmpdir(), "gbx-no-such-folder-here"))).toEqual([]);
  });
});

describe("gearboxEnabled", () => {
  it("is off only where the session image turned it off", () => {
    expect(gearboxEnabled({ STUDIO_GEARBOX_ENABLED: "0" })).toBe(false);
    expect(gearboxEnabled({ STUDIO_GEARBOX_ENABLED: " 0 " })).toBe(false);
    // The desktop sets nothing: on.
    expect(gearboxEnabled({})).toBe(true);
    expect(gearboxEnabled({ STUDIO_GEARBOX_ENABLED: "1" })).toBe(true);
    expect(gearboxEnabled({ STUDIO_GEARBOX_ENABLED: "" })).toBe(true);
  });
});

describe("folderOfWorkspaceUri", () => {
  let root: string;
  beforeEach(() => {
    // The desktop's layout: every project's folder, and beside each the
    // workspace file it opens as.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-ws-"));
    for (const project of ["Studio-web", "Test Worksoace - Gears-Rust"]) {
      fs.mkdirSync(path.join(root, project));
      fs.writeFileSync(
        path.join(root, `${project}.theia-workspace`),
        JSON.stringify({ folders: [{ path: project }], settings: {} }),
      );
    }
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const uri = (p: string) => pathToFileURL(p).toString();

  it("is the project's folder a desktop workspace file lists, not the folder of every project", () => {
    expect(folderOfWorkspaceUri(uri(path.join(root, "Studio-web.theia-workspace")))).toBe(path.join(root, "Studio-web"));
  });

  it("is the folder itself for a folder", () => {
    expect(folderOfWorkspaceUri(uri(path.join(root, "Studio-web")))).toBe(path.join(root, "Studio-web"));
  });

  it("is the one folder a file lists under another name, and beside it when several are listed", () => {
    const one = path.join(root, "mine.code-workspace");
    fs.writeFileSync(one, JSON.stringify({ folders: [{ path: "Studio-web" }] }));
    expect(folderOfWorkspaceUri(uri(one))).toBe(path.join(root, "Studio-web"));
    const several = path.join(root, "both.code-workspace");
    fs.writeFileSync(several, JSON.stringify({ folders: [{ path: "Studio-web" }, { path: "Test Worksoace - Gears-Rust" }] }));
    expect(folderOfWorkspaceUri(uri(several))).toBe(root);
  });

  it("is undefined off the local disk", () => {
    expect(folderOfWorkspaceUri("http://example.com/x")).toBeUndefined();
    expect(folderOfWorkspaceUri(undefined)).toBeUndefined();
  });
});
