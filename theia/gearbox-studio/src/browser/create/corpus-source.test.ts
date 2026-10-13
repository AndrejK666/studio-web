import type { SourceDecl } from "../../common/generated/SourceDecl";
import { corpusOffer, corpusSourceDecl, staleCorpusSource } from "./corpus-source";

const COPY = {
  id: "gears-rust",
  path: "C:\\Users\\me\\ConstructorStudio\\corpus\\github.com__o__gears-rust\\0123456789ab\\gears-rust",
};
const ORIGIN = {
  sourceId: "gears-rust",
  url: "https://github.com/o/gears-rust.git",
  rev: "0123456789ab".padEnd(40, "0"),
  needsToken: false,
};
const STUDIO_WEB = [{ path: "C:\\Repos\\studio-web", id: "studio-web" }];

describe("the corpus as a New Product source", () => {
  it("offers the machine's copy, checked, in a workspace with no gears of its own", () => {
    // studio-web opened on the desktop: the engine's only root is the copy.
    expect(corpusOffer({ copy: COPY, workspaceRoots: STUDIO_WEB, engineRoots: [COPY.path] })).toEqual({
      kind: "copy",
      copy: COPY,
      preselect: true,
    });
    expect(corpusOffer({ copy: COPY, workspaceRoots: STUDIO_WEB, engineRoots: [] })).toMatchObject({ preselect: true });
  });

  it("offers it unchecked beside a workspace that has gears of its own", () => {
    const offer = corpusOffer({
      copy: COPY,
      workspaceRoots: [{ path: "C:/p/my-gears", id: "my-gears" }],
      engineRoots: ["C:/p/my-gears", COPY.path.replace(/\\/g, "/")],
    });
    expect(offer).toEqual({ kind: "copy", copy: COPY, preselect: false });
  });

  it("does not offer it when the workspace has its own checkout of the corpus", () => {
    // A session: /workspace/gears-rust is a folder, the loader refuses two sources with one id.
    const offer = corpusOffer({
      copy: COPY,
      workspaceRoots: [{ path: "/workspace/gears-rust", id: "gears-rust" }],
      engineRoots: ["/workspace/gears-rust"],
    });
    expect(offer).toEqual({ kind: "none" });
  });

  it("offers to bring a public corpus the backend lists and this machine has no copy of", () => {
    expect(corpusOffer({ toBring: ORIGIN, bringable: true, workspaceRoots: STUDIO_WEB, engineRoots: [] })).toEqual({
      kind: "bring",
      origin: ORIGIN,
    });
  });

  it("says a private corpus comes through Studio, signed in on the desktop", () => {
    const privateOrigin = { ...ORIGIN, needsToken: true, clonePath: "/cf/studio-product/v1/gearbox/corpus" };
    const offer = corpusOffer({ toBring: privateOrigin, bringable: true, workspaceRoots: STUDIO_WEB, engineRoots: [] });
    expect(offer.kind).toBe("bring");
    expect(offer.kind === "bring" ? offer.note : undefined).toMatch(/private.*signed in/);
  });

  it("says why a corpus cannot be brought from here", () => {
    const offer = corpusOffer({
      toBring: { ...ORIGIN, needsToken: true },
      bringable: "This corpus is private, and this Studio does not relay it.",
      workspaceRoots: STUDIO_WEB,
      engineRoots: [],
    });
    expect(offer).toEqual({
      kind: "bring",
      origin: { ...ORIGIN, needsToken: true },
      unavailable: "This corpus is private, and this Studio does not relay it.",
    });
  });

  it("offers nothing when there is no corpus to speak of: a session is unchanged", () => {
    expect(corpusOffer({ workspaceRoots: [{ path: "/workspace/gears-rust", id: "gears-rust" }], engineRoots: [] })).toEqual({
      kind: "none",
    });
  });

  it("declares the copy as an absolute path source under the engine's id for it", () => {
    expect(corpusSourceDecl(COPY)).toEqual({
      id: "gears-rust",
      at: "C:/Users/me/ConstructorStudio/corpus/github.com__o__gears-rust/0123456789ab/gears-rust",
    });
  });
});

describe("a product reading an older copy of the corpus", () => {
  const OLD = "C:/Users/me/ConstructorStudio/corpus/github.com__o__gears-rust/52ba6948963e/gears-rust";
  const at = (path: string): SourceDecl => ({ kind: "path", at: path }) as SourceDecl;

  it("is noticed when the product names another commit's copy of the same repository", () => {
    const stale = staleCorpusSource({ "gears-rust": at(OLD) }, COPY);
    expect(stale).toMatchObject({
      id: "gears-rust",
      declaredCommit: "52ba6948963e",
      currentCommit: "0123456789ab",
      current: "C:/Users/me/ConstructorStudio/corpus/github.com__o__gears-rust/0123456789ab/gears-rust",
    });
  });

  it("is not noticed for the current copy, another repository, a checkout, or a git source", () => {
    expect(staleCorpusSource({ "gears-rust": at(COPY.path) }, COPY)).toBeUndefined();
    expect(staleCorpusSource({ "gears-rust": at(OLD.replace("gears-rust/52b", "other/52b")) }, COPY)).toBeUndefined();
    expect(staleCorpusSource({ "gears-rust": at("../../gears-rust") }, COPY)).toBeUndefined();
    expect(staleCorpusSource({ "gears-rust": { kind: "git", url: "https://github.com/o/gears-rust.git", rev: "52ba6948" } as SourceDecl }, COPY)).toBeUndefined();
    expect(staleCorpusSource({ "gears-rust": at(OLD) }, undefined)).toBeUndefined();
  });
});
