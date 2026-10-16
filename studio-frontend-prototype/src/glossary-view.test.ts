// The glossary helps a person settle the project's words: these pin which
// pairs it suggests are one thing, what counts as undefined, and that merging
// searches instead of listing every word.
import { describe, expect, it } from "vitest";

import { clarifySentence, filterRows, glossaryRows, mergeCandidates, pairVerdict, renameOffer, similarPairs, type GlossaryRow } from "./glossary-view";
import { entitiesOf, type GlossaryEntry, type SpecModelFact } from "./spec-model";

const entry = (name: string, facts = 5, extra: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
  key: name.toLowerCase(),
  name,
  chosen: false,
  spellings: [name],
  aliases: [],
  facts,
  documents: 2,
  ...extra,
});
const fact = (subject: string, kind: SpecModelFact["kind"], text = `${subject} ${kind}`): SpecModelFact => ({
  kind,
  subject,
  aspect: "",
  value: "",
  text,
  status: "active",
  status_because: "",
  source: { path: "docs/prd/x.md" },
});

describe("words that are probably one thing", () => {
  it("are a word and its -ship, and a word and its qualified form", () => {
    const pairs = similarPairs([entry("member", 20), entry("membership", 15), entry("organization membership", 4), entry("note", 9)]);
    expect(pairs.map((p) => [p.a.key, p.b.key])).toEqual([
      ["member", "membership"],
      ["membership", "organization membership"],
    ]);
    expect(pairs[0].why).toContain("-ship");
  });

  it("leave out words the documents barely mention", () => {
    expect(similarPairs([entry("member", 1), entry("membership", 1)])).toEqual([]);
  });
});

describe("the glossary's rows", () => {
  const entities = entitiesOf([fact("Project", "entity", "A project is a unit of work."), fact("Workspace", "attribute"), fact("Workspace", "lifecycle"), fact("Workspace", "constraint")]);
  const rows = glossaryRows([entry("project", 30), entry("workspace", 10)], entities);

  it("carry the definition a document gives, and the layer", () => {
    expect(rows[0].definition).toBe("A project is a unit of work.");
    expect(rows[0].layer).toBe("domain");
    expect(rows[1].definition).toBeNull();
  });

  it("filter to the entities nobody has defined", () => {
    expect(filterRows(rows, "undefined", "", []).map((r) => r.entry.key)).toEqual(["workspace"]);
    expect(filterRows(rows, "all", "unit of work", []).map((r) => r.entry.key)).toEqual(["project"]);
  });
});

describe("merging", () => {
  it("searches by name and never offers the entry itself or its aliases", () => {
    const all = [entry("member", 9, { aliases: [{ key: "teammate", name: "teammate" }] }), entry("membership", 5), entry("teammate", 2)];
    expect(mergeCandidates(all[0], all, "")).toEqual([]);
    expect(mergeCandidates(all[0], all, "mem").map((e) => e.key)).toEqual(["membership"]);
  });
});

describe("renameOffer", () => {
  it("offers the documents' name, never a member's earlier choice", () => {
    expect(renameOffer(entry("Member"), "Teammate")).toEqual({ from: "Member", to: "Teammate" });
    expect(renameOffer(entry("Mate", 5, { chosen: true, spellings: ["member", "Mate"] }), "Teammate")).toEqual({
      from: "member",
      to: "Teammate",
    });
  });
  it("offers nothing for the same word or an empty name", () => {
    expect(renameOffer(entry("Member"), "member ")).toBeNull();
    expect(renameOffer(entry("Member"), "  ")).toBeNull();
  });
});

describe("two things a member kept apart", () => {
  it("are not offered as one thing again", () => {
    const pairs = similarPairs([entry("membership", 9, { distinct_from: ["member"] }), entry("Member", 4)]);
    expect(pairs).toEqual([]);
  });
});

describe("a sentence that tells two words apart", () => {
  const pair = (a: string, b: string) => similarPairs([entry(a, 9), entry(b, 4)])[0];

  it("says what a level in front adds", () => {
    expect(clarifySentence(pair("membership", "organization membership"))).toBe("Organization membership is a **membership** at the organization level.");
  });

  it("says what a -ship word makes of the other", () => {
    expect(clarifySentence(pair("Member", "membership"))).toBe("A membership is what makes someone a **Member**.");
  });

  it("leaves the rest for a person to finish", () => {
    expect(clarifySentence(pair("build", "building"))).toBe("Building is not the same as **build**: …");
  });
});

describe("what to do with a pair", () => {
  const row = (e: GlossaryEntry, paths: string[], defined: boolean): GlossaryRow => ({
    entry: e,
    definition: defined ? "it is" : null,
    layer: null,
    definitions: defined ? [fact(e.name, "entity")] : [],
    paths,
  });
  const verdict = (a: [string, string[], boolean], b: [string, string[], boolean]) => {
    const ea = entry(a[0], 9);
    const eb = entry(b[0], 4);
    const rows = new Map([ea, eb].map((e, i) => [e.key, row(e, [a, b][i][1], [a, b][i][2])]));
    return pairVerdict(similarPairs([ea, eb])[0], (k) => rows.get(k));
  };

  it("reads a plural or an -ing form as one thing", () => {
    expect(verdict(["deploy", ["x.md"], true], ["deploying", ["y.md"], false]).action).toBe("same");
    expect(verdict(["project", ["x.md"], true], ["projects", ["x.md"], false]).action).toBe("same");
  });
  it("asks to tell a standing apart from the one who holds it", () => {
    const v = verdict(["member", ["x.md"], true], ["membership", ["x.md"], true]);
    expect(v.action).toBe("clarify");
    expect(v.why).toContain("“membership” names the standing");
  });
  it("reads a level in front without its own definition, said in the same documents, as the same thing", () => {
    const v = verdict(["membership", ["a.md", "b.md"], true], ["organization membership", ["a.md"], false]);
    expect(v.action).toBe("same");
    expect(v.evidence.shared).toBe(1);
  });
  it("asks to say a kind is a kind when both are defined in the same documents", () => {
    expect(verdict(["membership", ["a.md"], true], ["organization membership", ["a.md"], true]).action).toBe("clarify");
  });
  it("asks the same of two defined terms that never meet: a level in front names a kind", () => {
    expect(verdict(["membership", ["a.md"], true], ["organization membership", ["b.md"], true]).action).toBe("clarify");
  });
});
