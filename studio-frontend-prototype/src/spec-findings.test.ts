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
