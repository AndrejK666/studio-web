import { describe, expect, it } from "vitest";

import type { RegistryEntry } from "./api";
import { filterEntries, isDuplicated, projectsOf, registryProjects, stateCounts } from "./registry";

const entry = (name: string, extra: Partial<RegistryEntry> = {}): RegistryEntry => ({
  name,
  kind: "gear",
  state: "declared",
  capabilities: [],
  orphaned: false,
  occurrences: [{ project_id: "p1", project_name: "studio-web", repo: "cf/studio-web", path: `src/${name}`, declared_in: "attribute" }],
  ...extra,
});

describe("the registry", () => {
  const entries = [
    entry("studio-documents", { description: "document management" }),
    entry("studio-user", { state: "registered" }),
    entry("billing", {
      occurrences: [
        { project_id: "p1", project_name: "studio-web", repo: "cf/studio-web", path: "src/billing", declared_in: "attribute" },
        { project_id: "p2", project_name: "insight", repo: "cf/insight", path: "gears/billing", declared_in: "gear.toml" },
      ],
    }),
  ];

  it("counts by state", () => {
    expect(stateCounts(entries)).toEqual({ declared: 2, registered: 1 });
  });

  it("filters by state, project and text in names, descriptions and paths", () => {
    expect(filterEntries(entries, { state: "registered", q: "", project: null }).map((e) => e.name)).toEqual(["studio-user"]);
    expect(filterEntries(entries, { state: null, q: "", project: "p2" }).map((e) => e.name)).toEqual(["billing"]);
    expect(filterEntries(entries, { state: null, q: "document", project: null }).map((e) => e.name)).toEqual(["studio-documents"]);
    expect(filterEntries(entries, { state: null, q: "gears/bill", project: null }).map((e) => e.name)).toEqual(["billing"]);
  });

  it("names the projects and flags a component declared in two repositories", () => {
    expect(projectsOf(entries[2])).toEqual(["studio-web", "insight"]);
    expect(isDuplicated(entries[2])).toBe(true);
    expect(isDuplicated(entries[0])).toBe(false);
    expect(registryProjects(entries)).toEqual([
      { id: "p2", name: "insight" },
      { id: "p1", name: "studio-web" },
    ]);
  });
});
