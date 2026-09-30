import { describe, expect, it } from "vitest";
import { axesOf, demandText, reportSheets, type RoadmapReport, type RoadmapRow } from "./roadmap-report";
import { columnName, sheetName, sheetXml, xlsxFiles } from "./xlsx";

const row = (name: string, over: Partial<RoadmapRow["readiness"]> = {}): RoadmapRow => ({
  name,
  category: "core",
  assignees: "@a, @b",
  title: `CORE - ${name}`,
  number: 1,
  group: "CORE",
  components: name.startsWith("cf-") ? [name] : [],
  closed: false,
  off_board: false,
  effort_md: 40,
  remaining_md: 20,
  roadmap_title: `#1 ${name}`,
  readiness: {
    stage: "In Dev",
    stage_at: 3,
    stage_of: 6,
    lifecycle: null,
    milestone: "26.10",
    due: "2026-10-31",
    committed: true,
    plan: "on track",
    plan_lamp: "good",
    plan_reasons: [],
    demand: [],
    progress: [],
    last_release: null,
    released_on: null,
    used_by: null,
    roadmap_item: "https://github.com/o/r/issues/1",
    grade: "C",
    grade_fixes: [],
    ...over,
  },
});

const report: RoadmapReport = {
  items: [
    row("cf-gears-event-broker", {
      demand: [
        { consumer: "Virtuozzo", priority: 3 },
        { consumer: "Acronis", priority: 1 },
      ],
      progress: [
        { label: "Design", value: "80%", pct: 80 },
        { label: "SDK", value: "Done", pct: 100 },
      ],
    }),
    row("cf-gears-file-storage", {
      plan: "at risk",
      plan_lamp: "bad",
      plan_reasons: ["overdue: due 2026-07-31", "P1 for Acronis"],
      progress: [{ label: "Tests", value: "N/A", pct: null }],
    }),
  ],
  total: 2,
  not_in_code: 0,
  not_on_board: 5,
  summary: {
    by_group: [
      {
        group: "CORE",
        total: 2,
        done: 0,
        in_code: 2,
        axes: [
          { label: "Design", average: 80 },
          { label: "SDK", average: null },
        ],
        estimated: 2,
        effort_md: 80,
        remaining_md: 40,
      },
    ],
    by_stage: [{ label: "In Dev", count: 2 }],
    by_milestone: [{ milestone: "26.10", due: "2026-10-31", total: 2, committed: 2, at_risk: 1 }],
    by_consumer: [{ consumer: "Acronis", p1: 1, p2: 0, p3: 0, p1_not_on_track: 0 }],
    by_plan: [
      { label: "at risk", count: 1 },
      { label: "on track", count: 1 },
    ],
    overdue: ["cf-gears-file-storage"],
  },
};

describe("roadmap report sheets", () => {
  it("lists demand most urgent first and axes in board order", () => {
    expect(demandText(report.items[0].readiness.demand)).toBe("Acronis P1, Virtuozzo P3");
    expect(axesOf(report.items)).toEqual(["Design", "SDK", "Tests"]);
  });

  it("writes one Roadmap row per component, axes as columns", () => {
    const [roadmap, summary] = reportSheets(report, "2026-09-29");
    expect(roadmap.name).toBe("Roadmap");
    const [header, broker, files] = roadmap.rows;
    const col = (h: string) => header.indexOf(h);
    expect(broker[col("Gear")]).toBe("CORE - cf-gears-event-broker");
    expect(broker[col("Group")]).toBe("CORE");
    expect(broker[col("Components")]).toBe("cf-gears-event-broker");
    expect(broker[col("Remaining m*d")]).toBe(20);
    expect(broker[col("Design")]).toBe(80);
    expect(broker[col("SDK")]).toBe("Done");
    expect(broker[col("Tests")]).toBeNull();
    expect(broker[col("Effort m*d")]).toBe(40);
    expect(broker[col("Committed")]).toBe("yes");
    expect(broker[col("Why")]).toBeNull();
    expect(files[col("Why")]).toBe("overdue: due 2026-07-31; P1 for Acronis");
    expect(files[col("Tests")]).toBe("N/A");

    expect(summary.name).toBe("Summary");
    expect(summary.rows).toContainEqual(["Catalogued, not on the board", 5]);
    expect(summary.rows).toContainEqual(["Group", "Gears", "Done", "In code", "Design %", "SDK %", "Estimated", "Effort m*d", "Remaining m*d"]);
    expect(summary.rows).toContainEqual(["CORE", 2, 0, 2, 80, null, 2, 80, 40]);
    expect(summary.rows).toContainEqual(["26.10", "2026-10-31", 2, 2, 1]);
    expect(summary.rows.at(-1)).toEqual(["cf-gears-file-storage"]);
    const boldText = (summary.bold ?? []).map((i) => summary.rows[i][0]);
    expect(boldText).toEqual(["Roadmap report", "Group", "Stage", "Milestone", "Consumer", "Plan", "Overdue"]);
    expect(summary.freeze).toBe(false);
  });
});

describe("xlsx", () => {
  it("names columns past Z", () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
  });

  it("keeps sheet names legal", () => {
    expect(sheetName("a/b:c")).toBe("a b c");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
  });

  it("escapes text, writes numbers as numbers, skips empty cells", () => {
    const xml = sheetXml({ name: "S", rows: [["h"], ["<a & b>", 3, null, ""]] });
    expect(xml).toContain("&lt;a &amp; b&gt;");
    expect(xml).toContain('<c r="B2"><v>3</v></c>');
    expect(xml).not.toContain('r="C2"');
    expect(xml).toContain('<c r="A1" t="inlineStr" s="1">');
    expect(xml).toContain('state="frozen"');
  });

  it("packages one worksheet per sheet, with unique names", () => {
    const files = xlsxFiles([
      { name: "Roadmap", rows: [["a"]] },
      { name: "roadmap", rows: [["b"]] },
    ]);
    const names = files.map((f) => f.name);
    expect(names).toContain("xl/worksheets/sheet2.xml");
    const workbook = files.find((f) => f.name === "xl/workbook.xml")!.content;
    expect(workbook).toContain('name="Roadmap"');
    expect(workbook).toContain('name="roadmap 2"');
  });
});
