import type { CorpusOrigin } from "../common/protocol";
import { originsOf, unbringable } from "./corpus-origins";

const core: CorpusOrigin = { sourceId: "gears-core", url: "https://github.com/cf/gears-core.git", rev: "a", needsToken: false };
const acme: CorpusOrigin = {
  sourceId: "acme",
  url: "https://github.com/acme/gears.git",
  rev: "b",
  needsToken: true,
  clonePath: "/studio-product/v1/organizations/o1/gearbox/corpus/acme",
};

describe("corpus origins", () => {
  it("are every gear repository the backend names, or its one origin from an older backend", () => {
    expect(originsOf({ corpus: "x", gears: [], origin: core, origins: [core, acme] })).toEqual([core, acme]);
    expect(originsOf({ corpus: "x", gears: [], origin: core })).toEqual([core]);
    expect(originsOf({ corpus: "x", gears: [], origins: [] })).toEqual([]);
    expect(originsOf({ corpus: "x", gears: [] })).toEqual([]);
  });

  it("can be brought here only when each is public or relayed", () => {
    expect(unbringable([core, acme])).toBeUndefined();
    const closed = { ...acme, clonePath: undefined };
    expect(unbringable([core, closed])).toBe("The gear repository acme is private, and this Studio does not relay it.");
    expect(unbringable([{ ...core, needsToken: true }])).toBe("This corpus is private, and this Studio does not relay it.");
  });
});
