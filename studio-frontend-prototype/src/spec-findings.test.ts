import { describe, expect, it } from "vitest";
import type { SpecFinding } from "./api";
import {
  findingBreakdown,
  findingCount,
  findingDotTone,
  findingLabel,
  findingsByKind,
} from "./spec-findings";

// A `purpose` verdict exactly as the server recorded it on a local run over
// ADR-0019 (2026-10-01): the gate passed, and one section still read as design.
const purposeRecorded: SpecFinding = {
  detector: "purpose",
  subject: "e2e-node-adr19",
  path: "docs/adr/0019-a-role-narrows-what-a-member-may-do.md",
  severity: "gate-passed",
  summary: "purpose: adr (80% specification)",
  score: 0.805,
  details: {
    doc_type: "adr",
    spec_share: 0.805,
    gate_passed: true,
    findings: [
      {
        id: "7742df92c8cfd7435c1c76a4b7fc2f66",
        rule: "purpose.foreign_section",
        path: "docs/adr/0019-a-role-narrows-what-a-member-may-do.md",
        severity: "high",
        message: "ADR section reads as DESIGN (belongs in a design doc, not a adr)",
        anchor: { section: "8. The config read gets a cache", line_start: 244, line_end: 248, quote: null },
        related: [],
        evidence: ["llm: Describes caching mechanism, generation keying, and test tripwire."],
        confidence: 0.97,
      },
    ],
  },
};

const lowRepeat = (id: string) => ({
  id,
  rule: "bloat.self_repeat",
  severity: "low" as const,
  message: "This passage appears 2 times in this document",
  related: [],
  evidence: [],
});

describe("a document's findings on the Specs list", () => {
  it("counts the places a detector found, not the detectors that looked", () => {
    const bloat: SpecFinding = {
      detector: "bloat",
      subject: "n",
      severity: "clean",
      details: { repeats: [], findings: [lowRepeat("a"), lowRepeat("b")] },
    };
    expect(findingCount([purposeRecorded, bloat])).toBe(3);
    expect(findingLabel([purposeRecorded, bloat])).toBe("3 findings");
  });

  it("colours a passed gate red when one of its findings is high", () => {
    // The gate is a share against a threshold; a section at 0.97 confidence
    // that belongs in another document is still the thing to look at.
    expect(findingDotTone([purposeRecorded])).toBe("var(--destructive)");
  });

  it("colours only-low findings amber", () => {
    const bloat: SpecFinding = { detector: "bloat", subject: "n", severity: "clean", details: { findings: [lowRepeat("a")] } };
    expect(findingDotTone([bloat])).toBe("var(--warning)");
  });

  it("says 'No findings' and green when the detectors looked and placed nothing", () => {
    const clean: SpecFinding = { detector: "leak", subject: "n", severity: "clean", details: { passed: true, findings: [] } };
    expect(findingLabel([clean])).toBe("No findings");
    expect(findingDotTone([clean])).toBe("var(--success)");
  });

  it("counts a failed verdict recorded before findings were kept as one", () => {
    const old: SpecFinding = { detector: "leak", subject: "n", severity: "high", summary: "leak: reads partly as design" };
    expect(findingCount([old])).toBe(1);
    expect(findingDotTone([old])).toBe("var(--destructive)");
  });

  it("falls back to conformance when no detector has looked", () => {
    expect(findingLabel(undefined)).toBe("No findings");
    expect(findingDotTone(undefined, false)).toBe("var(--warning)");
    expect(findingDotTone([], true)).toBe("var(--success)");
  });
});

describe("a document's findings by kind", () => {
  it("counts each kind and lists the commonest first", () => {
    const verdicts: SpecFinding[] = [
      purposeRecorded,
      {
        detector: "bloat",
        subject: "n",
        severity: "clean",
        details: { findings: [lowRepeat("a"), lowRepeat("b")] },
      },
      { detector: "leak", subject: "n", severity: "high" },
    ];
    expect(findingsByKind(verdicts).map((k) => [k.rule, k.count, k.high])).toEqual([
      ["bloat.self_repeat", 2, false],
      ["leak", 1, true],
      ["purpose.foreign_section", 1, true],
    ]);
    expect(findingBreakdown(verdicts)).toBe(
      "2 repeats within the doc · 1 leak · 1 section of another kind",
    );
  });

  it("has nothing to say about a clean document", () => {
    expect(findingBreakdown([{ detector: "leak", subject: "n", severity: "clean", details: { findings: [] } }])).toBe("");
  });
});

// Verdicts recorded before the server kept findings carry no `details` at all,
// or `details` without `findings`. They still have to read the way the row
// read when they were written: a failed one is one complaint, a passed one is
// nothing, and neither throws.
describe("verdicts recorded before findings were kept", () => {
  it("counts a passed old verdict as nothing and a gate-failed one as one", () => {
    const passed: SpecFinding = { detector: "purpose", subject: "n", severity: "gate-passed" };
    const failed: SpecFinding = { detector: "purpose", subject: "n", severity: "gate-failed" };
    expect(findingCount([passed])).toBe(0);
    expect(findingDotTone([passed])).toBe("var(--success)");
    expect(findingCount([failed])).toBe(1);
    expect(findingsByKind([failed]).map((k) => [k.rule, k.label, k.count, k.high])).toEqual([
      ["purpose", "purpose", 1, true],
    ]);
  });

  it("reads details without a findings array as no findings, not a crash", () => {
    const noList: SpecFinding = { detector: "leak", subject: "n", severity: "clean", details: { passed: true } };
    const notAnArray: SpecFinding = { detector: "bloat", subject: "n", severity: "clean", details: { findings: "none" } };
    const nullDetails: SpecFinding = { detector: "leak", subject: "n", severity: "high", details: null };
    expect(findingCount([noList, notAnArray])).toBe(0);
    expect(findingBreakdown([noList, notAnArray])).toBe("");
    // A null `details` is an old record too, and a failed one still counts.
    expect(findingCount([nullDetails])).toBe(1);
  });

  // A failed verdict that DOES carry findings is counted by its findings: the
  // verdict is their summary, and counting it as well would say one more
  // thing is wrong than the text shows.
  it("does not count a failed verdict on top of the findings it carries", () => {
    const failedWithItems: SpecFinding = { ...purposeRecorded, severity: "gate-failed" };
    expect(findingCount([failedWithItems])).toBe(1);
    expect(findingsByKind([failedWithItems]).map((k) => k.rule)).toEqual(["purpose.foreign_section"]);
  });
});

const item = (id: string, rule: string, severity: "high" | "medium" | "low") => ({
  id,
  rule,
  severity,
  message: "m",
  related: [],
  evidence: [],
});

describe("mixed kinds and their labels", () => {
  it("mixes an old failed verdict with new findings in one count and one breakdown", () => {
    const verdicts: SpecFinding[] = [
      { detector: "leak", subject: "n", severity: "high" },
      {
        detector: "bloat",
        subject: "n",
        severity: "high",
        details: {
          findings: [
            item("x1", "bloat.cross_document", "medium"),
            item("x2", "bloat.cross_document", "medium"),
            lowRepeat("r1"),
          ],
        },
      },
    ];
    expect(findingCount(verdicts)).toBe(4);
    expect(findingLabel(verdicts)).toBe("4 findings");
    expect(findingBreakdown(verdicts)).toBe(
      "2 duplicates of other docs · 1 repeat within the doc · 1 leak",
    );
    // The old failed leak is what makes the row red: no new finding is high.
    expect(findingDotTone(verdicts)).toBe("var(--destructive)");
  });

  it("uses the singular for one finding of a known kind and the plural for more", () => {
    const one: SpecFinding = {
      detector: "leak",
      subject: "n",
      severity: "high",
      details: { findings: [item("l1", "leak.foreign_content", "high")] },
    };
    const two: SpecFinding = {
      ...one,
      details: { findings: [item("l1", "leak.foreign_content", "high"), item("l2", "leak.foreign_content", "low")] },
    };
    expect(findingBreakdown([one])).toBe("1 foreign passage");
    expect(findingBreakdown([two])).toBe("2 foreign passages");
    expect(findingLabel([one])).toBe("1 finding");
  });

  // A rule the detectors add before this list learns its name must still be
  // shown, under its id, rather than vanish from the breakdown or the count.
  it("falls back to the rule id for a rule it has no label for", () => {
    const novel: SpecFinding = {
      detector: "traceability",
      subject: "n",
      severity: "some",
      details: {
        findings: [item("t1", "traceability.dangling_ref", "medium"), item("t2", "traceability.dangling_ref", "medium")],
      },
    };
    expect(findingsByKind([novel])).toEqual([
      { rule: "traceability.dangling_ref", label: "traceability.dangling_ref", count: 2, high: false },
    ]);
    expect(findingBreakdown([novel])).toBe("2 traceability.dangling_ref");
    expect(findingDotTone([novel])).toBe("var(--warning)");
  });

  it("orders kinds of equal count by rule id, so a row does not reshuffle between renders", () => {
    const verdicts: SpecFinding[] = [
      { detector: "purpose", subject: "n", severity: "gate-failed" },
      { detector: "leak", subject: "n", severity: "high" },
    ];
    expect(findingsByKind(verdicts).map((k) => k.rule)).toEqual(["leak", "purpose"]);
  });
});
