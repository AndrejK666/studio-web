// The source-list workaround for https://github.com/MikeFalcon77/gearbox/issues/1:
// the text rule, the exact GBX0101 reproduction, and the guard around the write.
import "reflect-metadata";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { closeSourcesList, sourcesListNeedsComma } from "./sources-list";
import { GearboxServiceImpl } from "./gearbox-service-impl";

/**
 * What `product/create` writes for a blank product with one source, byte for
 * byte (engine 3b64969 and 55f7015: `render_product_template` joins the entries
 * with `,\n` and adds no comma after the last).
 */
const CREATED = `# Generated product description for fresh-src.
#
# Edit this file in Gearbox Studio. Comments carry the reasoning for choices
# made here — preserve them when changing the description.

product(
    id = "fresh-src",
    name = "fresh-src",
    version = "0.1.0",

    sources = [
        source(id = "gears-rust", at = path("../../gears-rust"))
    ],

    profiles = [
        embedded(id = "dev"),
    ],
    default_profile = "dev",

    gears = [
    ],
)
`;

const NEW_SOURCE = `source(id = "gears", at = path("gears"))`;

/**
 * `add_source`'s append, as gearbox-gdl `insert_entry` does it for a list whose
 * entries sit on their own lines: `<indent><entry>,\n` in front of the line
 * holding `]`, and nothing added after the previous entry.
 */
function engineAppend(text: string, entry: string): string {
  const open = text.indexOf("sources = [");
  const close = text.indexOf("]", text.indexOf("\n", open));
  const cut = text.lastIndexOf("\n", close) + 1;
  return `${text.slice(0, cut)}        ${entry},\n${text.slice(cut)}`;
}

/** The entries of the sources list as the parser would see them: separated by commas at depth 0. */
function sourcesEntries(text: string): string[] {
  const open = text.indexOf("sources = [") + "sources = [".length;
  let depth = 0;
  let current = "";
  const entries: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text.charAt(i);
    if (depth === 0 && c === "]") break;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && c === ",") {
      entries.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "") entries.push(current.trim());
  return entries;
}

describe("the GBX0101 reproduction", () => {
  it("is what the engine's append makes of a created product", () => {
    // Two `source(...)` with nothing between them: the parser reads the second
    // as `unexpected identifier 'source', expected symbol ']'` (GBX0101).
    const broken = engineAppend(CREATED, NEW_SOURCE);
    expect(broken).toContain(`path("../../gears-rust"))\n        source(id = "gears"`);
    expect(sourcesEntries(broken)).toHaveLength(1);
  });

  it("does not happen once the list is closed first", () => {
    const closed = closeSourcesList(CREATED);
    expect(closed).toBeDefined();
    const fixed = engineAppend(closed as string, NEW_SOURCE);
    expect(fixed).toContain(`path("../../gears-rust")),\n        source(id = "gears", at = path("gears")),\n    ],`);
    expect(sourcesEntries(fixed)).toEqual([
      `source(id = "gears-rust", at = path("../../gears-rust"))`,
      NEW_SOURCE,
    ]);
  });
});

describe("closing the sources list", () => {
  it("adds exactly one comma, after the last entry, and nothing else", () => {
    const closed = closeSourcesList(CREATED) as string;
    expect(closed.length).toBe(CREATED.length + 1);
    expect(closed.replace(`path("../../gears-rust")),`, `path("../../gears-rust"))`)).toBe(CREATED);
    expect(closeSourcesList(closed)).toBeUndefined();
  });

  it("leaves a list that already ends with a comma alone", () => {
    expect(closeSourcesList(CREATED.replace(`gears-rust"))\n`, `gears-rust")),\n`))).toBeUndefined();
  });

  it("leaves an empty list and a one-line list alone -- the engine appends `, entry` to those", () => {
    expect(closeSourcesList(`product(\n    sources = [\n    ],\n)\n`)).toBeUndefined();
    expect(closeSourcesList(`product(sources = [source(id = "a", at = path("a"))])\n`)).toBeUndefined();
  });

  it("leaves a description with no sources alone", () => {
    expect(closeSourcesList(`product(id = "x")\n`)).toBeUndefined();
    expect(sourcesListNeedsComma(`product(id = "x")\n`)).toBe(false);
  });

  it("puts the comma before a trailing comment, not after it", () => {
    const text = `product(\n    sources = [\n        source(id = "a", at = path("a"))  # the corpus ]\n    ],\n)\n`;
    expect(closeSourcesList(text)).toBe(
      `product(\n    sources = [\n        source(id = "a", at = path("a")),  # the corpus ]\n    ],\n)\n`,
    );
  });

  it("is not fooled by brackets and commas inside strings", () => {
    const text = `product(\n    sources = [\n        source(id = "a", at = path("dir],[x"))\n    ],\n)\n`;
    expect(closeSourcesList(text)).toBe(
      `product(\n    sources = [\n        source(id = "a", at = path("dir],[x")),\n    ],\n)\n`,
    );
  });

  it("closes the list Studio writes for the corpus, a git source", () => {
    const text =
      `product(\n    sources = [\n        source(id = "gears-rust", at = git(url = "https://github.com/x/gears-rust.git", rev = "a0a42ce"))\n    ],\n)\n`;
    expect(closeSourcesList(text)).toContain(`rev = "a0a42ce")),\n    ],`);
  });

  it("reads only `sources`, not a key that ends with it or a comment that names it", () => {
    const text = `# sources = [ here\nproduct(\n    my_sources = [\n        "a"\n    ],\n)\n`;
    expect(closeSourcesList(text)).toBeUndefined();
  });

  it("keeps CRLF line ends as they were", () => {
    const crlf = CREATED.replace(/\n/g, "\r\n");
    const closed = closeSourcesList(crlf) as string;
    expect(closed).toContain(`path("../../gears-rust")),\r\n    ],`);
    expect(closed.replace(/\r\n/g, "").length).toBe(CREATED.replace(/\n/g, "").length + 1);
  });
});

describe("the guard around the write", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-sources-"));
    file = path.join(dir, "product.gdl");
    fs.writeFileSync(file, CREATED);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The service with a fake engine behind `loadProduct` and a quiet logger. */
  function serviceWith(load: (text: string) => unknown): GearboxServiceImpl & { closeSourcesListFor(p: string): Promise<boolean> } {
    const service = Object.create(GearboxServiceImpl.prototype) as GearboxServiceImpl & {
      closeSourcesListFor(p: string): Promise<boolean>;
    };
    Object.assign(service, {
      logger: { info: () => undefined, warn: () => undefined },
      loadProduct: async (p: string) => load(fs.readFileSync(p, "utf8")),
    });
    return service;
  }

  const sources = { "gears-rust": { kind: "path", at: "../../gears-rust" } };

  it("writes the comma when the engine reads the same sources before and after", async () => {
    const service = serviceWith(() => ({ intent: { sources } }));
    await expect(service.closeSourcesListFor(file)).resolves.toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(closeSourcesList(CREATED));
  });

  it("puts the old text back when the engine cannot read the new one", async () => {
    const service = serviceWith((text) => {
      if (text !== CREATED) throw new Error("GBX0101 Parse error");
      return { intent: { sources } };
    });
    await expect(service.closeSourcesListFor(file)).resolves.toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(CREATED);
  });

  it("puts the old text back when the new one reads with different sources", async () => {
    const service = serviceWith((text) => ({ intent: { sources: text === CREATED ? sources : {} } }));
    await expect(service.closeSourcesListFor(file)).resolves.toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(CREATED);
  });

  it("touches nothing when the product does not read now", async () => {
    const service = serviceWith(() => {
      throw new Error("GBX0102");
    });
    await expect(service.closeSourcesListFor(file)).resolves.toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(CREATED);
  });

  it("touches nothing, and asks the engine nothing, when the list is already closed", async () => {
    const closed = closeSourcesList(CREATED) as string;
    fs.writeFileSync(file, closed);
    const load = jest.fn();
    await expect(serviceWith(load).closeSourcesListFor(file)).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(closed);
  });

  it("runs before a batch that adds a source, and not before any other", async () => {
    const service = Object.create(GearboxServiceImpl.prototype) as GearboxServiceImpl;
    const order: string[] = [];
    Object.assign(service, {
      closeSourcesListFor: async () => {
        order.push("close");
        return true;
      },
      request: async (method: string) => {
        order.push(method);
        return { changed: true, before: "", after: "" };
      },
    });
    await service.applyEdits(file, [{ kind: "set_features", gear: "g", features: [] }], true);
    await service.applyEdits(file, [{ kind: "add_source", id: "gears", at: "gears" }, { kind: "add_gear", gear: "g", source: "gears" }], true);
    expect(order).toEqual(["gearbox/product/applyEdits", "close", "gearbox/product/applyEdits"]);
  });
});
