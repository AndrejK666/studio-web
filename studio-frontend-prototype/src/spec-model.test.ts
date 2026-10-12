import { describe, expect, it } from "vitest";
import {
  buildLine,
  coverageCounts,
  entitiesOf,
  factsByKind,
  orderFindings,
  relatedEntities,
  sideLabel,
  subjectKey,
  type SpecModelFact,
  type SpecModelFinding,
} from "./spec-model";

function fact(subject: string, kind: SpecModelFact["kind"], path = "a.md", extra: Partial<SpecModelFact> = {}): SpecModelFact {
  return {
    kind,
    subject,
    aspect: "",
    value: "",
    text: `${subject} ${kind}`,
    status: "active",
    status_because: "",
    source: { path, line_start: 1, line_end: 1, quote: "q" },
    ...extra,
  };
}

describe("subjectKey", () => {
  it("folds case, articles, punctuation and a plural s, like the backend", () => {
    expect(subjectKey("The Seat Snapshots")).toBe(subjectKey("seat-snapshot"));
    expect(subjectKey("status")).toBe("status");
    expect(subjectKey("access")).toBe("access");
  });
});

describe("entitiesOf", () => {
  it("merges spellings, names an entity by its commonest one, and counts documents", () => {
    const facts = [
      fact("Seat snapshot", "entity", "a.md"),
      fact("seat snapshots", "attribute", "b.md"),
      fact("Seat snapshot", "lifecycle", "a.md", { status: "deferred" }),
      fact("Gateway", "constraint"),
    ];
    const [seat, gateway] = entitiesOf(facts);
    expect(seat.name).toBe("Seat snapshot");
    expect(seat.facts).toHaveLength(3);
    expect(seat.documents).toBe(2);
    expect(seat.active).toBe(2);
    expect(gateway.name).toBe("Gateway");
  });

  it("leaves out a subject that is only a decision", () => {
    expect(entitiesOf([fact("Use Postgres", "decision")])).toEqual([]);
  });
});

describe("factsByKind", () => {
  it("orders what it is before what is required of it, and drops empty kinds", () => {
    const groups = factsByKind([fact("x", "requirement"), fact("x", "entity"), fact("x", "attribute")]);
    expect(groups.map((g) => g.kind)).toEqual(["entity", "attribute", "requirement"]);
  });
});

describe("relatedEntities", () => {
  it("follows a relation whose value names another entity", () => {
    const all = entitiesOf([
      fact("Person", "entity"),
      fact("Person", "relation", "a.md", { value: "many Source Accounts" }),
      fact("Source account", "entity"),
    ]);
    const person = all.find((e) => e.key === "person")!;
    expect(relatedEntities(person, all)).toEqual(["source account"]);
  });
});

describe("orderFindings", () => {
  const f = (fingerprint: string, extra: Partial<SpecModelFinding>): SpecModelFinding => ({
    fingerprint,
    rule: "contradiction.value",
    severity: "high",
    message: "",
    sides: [],
    decide: [],
    ...extra,
  });

  it("puts undecided first, dismissed last, high before medium, disagreements before references", () => {
    const ordered = orderFindings([
      f("dismissed", { decision: "dismissed" }),
      f("ref", { rule: "reference.dangling" }),
      f("medium", { severity: "medium" }),
      f("confirmed", { decision: "confirmed" }),
      f("high", {}),
    ]);
    expect(ordered.map((x) => x.fingerprint)).toEqual(["high", "ref", "medium", "confirmed", "dismissed"]);
  });
});

describe("coverage and progress", () => {
  it("counts documents per state", () => {
    const counts = coverageCounts([
      { path: "a", revision: "r", state: "extracted", facts: 3, dropped: 0 },
      { path: "b", revision: "r", state: "pending", facts: 0, dropped: 0 },
      { path: "c", revision: "r", state: "pending", facts: 0, dropped: 0 },
    ]);
    expect(counts).toEqual({ extracted: 1, failed: 0, stale: 0, pending: 2 });
  });

  it("says what a build is doing, or why it stopped", () => {
    const base = { running: true, documents: 4, done: 1, candidates: 0, judged: 0, current: "docs/PRD.md" };
    expect(buildLine(base)).toBe("Reading documents 1/4 · docs/PRD.md");
    expect(buildLine({ ...base, done: 4, candidates: 10, judged: 3 })).toBe("Checking disagreements 3/10");
    expect(buildLine({ ...base, running: false, error: "add a key" })).toBe("Stopped: add a key");
  });

  it("labels a side by its lines", () => {
    expect(sideLabel({ path: "a.md", line_start: 3, line_end: 5 })).toBe("a.md:3-5");
    expect(sideLabel({ path: "a.md", line_start: 3, line_end: 3 })).toBe("a.md:3");
    expect(sideLabel({ path: "a.md" })).toBe("a.md");
  });
});
