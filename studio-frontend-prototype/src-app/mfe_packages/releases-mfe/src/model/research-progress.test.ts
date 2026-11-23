import { describe, expect, it } from "vitest";
import { bytesLabel, numberLabel, overallShare, researchProgressOf, stepShare } from "./research-progress";

const upload = {
  progress: {
    step: "upload",
    index: 2,
    steps: ["prepare", "desk", "upload", "images", "deploy", "ready"],
    files: { done: 1240, total: 3812 },
    bytes: { done: 46_000_000, total: 120_000_000 },
  },
};

describe("a Research run's progress", () => {
  it("is read from the run's result, and nothing else is taken for it", () => {
    expect(researchProgressOf(upload)).toEqual({
      step: "upload",
      files: { done: 1240, total: 3812 },
      bytes: { done: 46_000_000, total: 120_000_000 },
      images: undefined,
    });
    expect(researchProgressOf(null)).toBeNull();
    expect(researchProgressOf({})).toBeNull();
    expect(researchProgressOf({ progress: { step: "launch" } })).toBeNull();
    expect(researchProgressOf({ progress: { step: "upload", files: { done: "x" } } })?.files).toBeUndefined();
  });

  it("is determinate by bytes in the upload, by images in the builds, and not at the desk", () => {
    const p = researchProgressOf(upload)!;
    expect(stepShare(p)).toBeCloseTo(46 / 120);
    expect(stepShare({ step: "upload", files: { done: 1, total: 4 }, bytes: { done: 0, total: 0 } })).toBe(0.25);
    expect(stepShare({ step: "images", images: { done: 1, total: 3 } })).toBeCloseTo(1 / 3);
    expect(stepShare({ step: "desk" })).toBeNull();
    expect(stepShare({ step: "upload" })).toBeNull();
  });

  it("goes the whole way by steps, the current one as far as it is", () => {
    expect(overallShare({ step: "prepare" })).toBe(0);
    expect(overallShare({ step: "desk" })).toBeCloseTo(1 / 6);
    expect(overallShare(researchProgressOf(upload)!)).toBeCloseTo((2 + 46 / 120) / 6);
    expect(overallShare({ step: "ready" })).toBe(1);
  });

  it("says counts and sizes as people read them", () => {
    expect(numberLabel(3812, "en")).toBe("3,812");
    expect(numberLabel(3812, "ru").replace(/\s/g, " ")).toBe("3 812");
    expect(bytesLabel(46_000_000)).toBe("46 MB");
    expect(bytesLabel(1_200_000_000)).toBe("1.2 GB");
    expect(bytesLabel(820)).toBe("820 B");
  });
});
