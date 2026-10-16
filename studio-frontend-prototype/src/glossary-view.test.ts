// The glossary helps a person settle the project's words: these pin which
// pairs it suggests are one thing, what counts as undefined, and that merging
// searches instead of listing every word.
import { describe, expect, it } from "vitest";

import { clarifySentence, filterRows, glossaryRows, mergeCandidates, renameOffer, similarPairs } from "./glossary-view";
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
