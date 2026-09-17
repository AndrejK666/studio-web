import { describe, expect, it } from "vitest";

import { duplicationByDocument, weightedMixture } from "./analysis";

/** Three clusters as the service actually returned them, trimmed to the keys
 *  the fold reads.
 *
 *  Taken from a real `bloat` run over fifteen issue/PR documents, not invented:
 *  the two lexical clusters each repeat inside ONE file (a CodeRabbit line
 *  posted three times in the same thread), and the semantic one spans two
 *  files. That mixture is the whole reason the fold distinguishes "repeats
 *  itself" from "repeats another document", and a hand-written fixture would
 *  most likely have had only the second kind. */
const CLUSTERS = [
  {
    confidence: 0.756,
    cross_section: true,
    source: "semantic",
    occurrences: [
      {
        file: "issues/2524-pr-400-docs-spec-templates.md",
        section: "PR #400",
        line: 17,
        tokens: new Array(28).fill("w"),
      },
      {
        file: "issues/2840-pr-986-feat-outbox.md",
        section: "PR #986",
        line: 17,
        tokens: new Array(28).fill("w"),
      },
    ],
  },
  {
    confidence: 0.857,
    cross_section: false,
    source: "lexical",
    occurrences: [
      { file: "issues/2840-pr-986-feat-outbox.md", line: 25, tokens: new Array(17).fill("w") },
      { file: "issues/2840-pr-986-feat-outbox.md", line: 26, tokens: new Array(17).fill("w") },
      { file: "issues/2840-pr-986-feat-outbox.md", line: 27, tokens: new Array(17).fill("w") },
    ],
  },
  {
    confidence: 0.818,
    cross_section: false,
    source: "lexical",
    occurrences: [
      { file: "issues/2524-pr-400-docs-spec-templates.md", line: 25, tokens: new Array(14).fill("w") },
      { file: "issues/2524-pr-400-docs-spec-templates.md", line: 26, tokens: new Array(14).fill("w") },
      { file: "issues/2524-pr-400-docs-spec-templates.md", line: 27, tokens: new Array(14).fill("w") },
    ],
  },
];

describe("duplicationByDocument", () => {
  it("counts a cluster once per file, however many times the file occurs in it", () => {
    const rows = duplicationByDocument(CLUSTERS);
    const outbox = rows.find((r) => r.path.includes("2840"))!;

    // Two clusters, four occurrences: one in the semantic cluster and three in
    // the lexical one. Counting clusters per occurrence would say four.
    expect(outbox.clusters).toBe(2);
    expect(outbox.occurrences).toBe(4);
    expect(outbox.words).toBe(28 + 17 * 3);
  });

  it("names the documents a file shares text with, and only those", () => {
    const rows = duplicationByDocument(CLUSTERS);
    const outbox = rows.find((r) => r.path.includes("2840"))!;
    const templates = rows.find((r) => r.path.includes("2524"))!;

    // The semantic cluster pairs them; neither lexical cluster adds a partner,
    // because each repeats inside a single file.
    expect(outbox.partners).toEqual(["issues/2524-pr-400-docs-spec-templates.md"]);
    expect(templates.partners).toEqual(["issues/2840-pr-986-feat-outbox.md"]);
  });

  it("leaves a document that only repeats itself with no partners", () => {
    const rows = duplicationByDocument([CLUSTERS[1]]);
    expect(rows).toHaveLength(1);
    expect(rows[0].partners).toEqual([]);
    expect(rows[0].clusters).toBe(1);
    expect(rows[0].occurrences).toBe(3);
  });

  it("ranks the worst offender first, by duplicated words", () => {
    const rows = duplicationByDocument(CLUSTERS);
    expect(rows.map((r) => r.words)).toEqual([79, 70]);
    expect(rows[0].path).toContain("2840");
  });

  it("lists only the documents that appear in a cluster", () => {
    // Fifteen documents were scanned; two of them duplicate anything. The
    // clean thirteen are not rows here — the caller states the total instead.
    expect(duplicationByDocument(CLUSTERS)).toHaveLength(2);
  });

  it("survives a payload whose shape it was not told about", () => {
    expect(duplicationByDocument(null)).toEqual([]);
    expect(duplicationByDocument([{}, { occurrences: null }])).toEqual([]);
    // An occurrence with no file is skipped; one with no tokens counts as an
    // occurrence of zero words rather than as NaN.
    const rows = duplicationByDocument([{ occurrences: [{ file: "a.md" }, { line: 3 }] }]);
    expect(rows).toEqual([{ path: "a.md", clusters: 1, occurrences: 1, words: 0, partners: [] }]);
  });
});

describe("weightedMixture", () => {
  it("weights each document by its length, not by being a document", () => {
    const { mixture, tokens } = weightedMixture([
      { mixture: { requirement: 1, other: 0 }, n_tokens: 4000 },
      { mixture: { requirement: 0, other: 1 }, n_tokens: 40 },
    ]);

    expect(tokens).toBe(4040);
    // A plain average would call this set half requirement and half other,
    // which is exactly the wrong answer about 4,040 words.
    expect(mixture.requirement).toBeCloseTo(4000 / 4040, 6);
    expect(mixture.other).toBeCloseTo(40 / 4040, 6);
  });

  it("keeps a document that reports a mixture but no length", () => {
    const { mixture, tokens } = weightedMixture([
      { mixture: { design: 1 }, n_tokens: 9 },
      { mixture: { other: 1 } },
    ]);
    expect(tokens).toBe(10);
    expect(mixture.design).toBeCloseTo(0.9, 6);
    expect(mixture.other).toBeCloseTo(0.1, 6);
  });

  it("returns an empty mixture, not four zeroes, when nothing was readable", () => {
    // An empty bar reads as "nothing to show"; a bar of confident zeroes reads
    // as a finding about the documents, which this is not.
    expect(weightedMixture([])).toEqual({ mixture: {}, tokens: 0 });
    expect(weightedMixture([null, undefined, {}, { mixture: null }])).toEqual({
      mixture: {},
      tokens: 0,
    });
  });

  it("ignores a share that is not a finite number", () => {
    const { mixture } = weightedMixture([
      { mixture: { requirement: 1, design: Number.NaN } as never, n_tokens: 10 },
    ]);
    expect(mixture.requirement).toBe(1);
    expect(mixture.design).toBeUndefined();
  });
});
