import { describe, expect, it } from "vitest";

import type { RegistryEntry } from "./api";
import {
  ACTION_LABEL,
  REGISTRY_STATES,
  STATE_LABEL,
  allowedActions,
  decisionLine,
  decisionRefusal,
  decisionTargets,
  filterEntries,
  isDuplicated,
  ownerLabel,
  projectsOf,
  registryProjects,
  stateCounts,
  walkLine,
} from "./registry";

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

describe("what the last walk saw", () => {
  const at = "2026-10-09T13:00:00Z";
  it("says a project was not readable, and what to do", () => {
    const line = walkLine({
      project_id: "p1",
      project_name: "studio-web",
      at,
      repos: [{ repo: "cf/studio-web", status: "failed", components: 0, error: "not readable", hint: "Share the connection" }],
    });
    expect(line).toEqual({ text: "1 of 1 repository not readable", failed: true, hint: "Share the connection" });
  });

  it("counts what it read, and says when nothing changed", () => {
    expect(
      walkLine({ project_id: "p", project_name: "x", at, repos: [{ repo: "a", status: "unchanged", components: 2 }, { repo: "b", status: "read", components: 1 }] }),
    ).toEqual({ text: "read · 3 components", failed: false, hint: null });
    expect(walkLine(undefined).text).toBe("not read yet");
  });
});

describe("decisions about an entry", () => {
  it("offers the moves the server allows from each state", () => {
    expect(allowedActions("declared")).toEqual(["register", "reject", "merge", "edit"]);
    expect(allowedActions("candidate")).toEqual(["register", "reject", "merge", "edit"]);
    expect(allowedActions("registered")).toEqual(["publish", "deprecate", "merge", "edit"]);
    expect(allowedActions("published")).toEqual(["deprecate", "merge", "edit"]);
    expect(allowedActions("rejected")).toEqual(["restore", "merge", "edit"]);
    expect(allowedActions("deprecated")).toEqual(["restore", "merge", "edit"]);
    expect(allowedActions("merged")).toEqual(["edit"]);
    expect(allowedActions("unheard-of")).toEqual([]);
    for (const s of REGISTRY_STATES) {
      expect(STATE_LABEL[s]).toBeTruthy();
      for (const a of allowedActions(s)) expect(ACTION_LABEL[a]).toBeTruthy();
    }
  });

  it("names an owner and the entries a decision may point at", () => {
    expect(ownerLabel({ kind: "person", id: "u1", name: "Ada" })).toBe("Ada (person)");
    expect(ownerLabel({ kind: "team", name: "Payments" })).toBe("Payments (team)");
    expect(ownerLabel(null)).toBeNull();
    const all = [
      entry("billing"),
      entry("ledger", { state: "registered" }),
      entry("old", { state: "merged" }),
      entry("Alpha"),
    ];
    expect(decisionTargets(all, "Billing")).toEqual(["Alpha", "ledger"]);
  });

  it("writes a decision as one line, with who, the move and why", () => {
    const at = "2026-10-09T12:00:00Z";
    expect(
      decisionLine(
        { action: "deprecate", from: "registered", to: "deprecated", by: "u1", at, reason: "superseded", details: { replaced_by: "ledger" } },
        { u1: "Ada" },
      ),
    ).toBe("Ada deprecated (registered → deprecated): use ledger instead — “superseded”");
    expect(
      decisionLine({
        action: "register",
        from: "declared",
        to: "registered",
        by: "u2",
        by_name: "Bob",
        at,
        details: { owner: { kind: "team", name: "Payments" } },
      }),
    ).toBe("Bob registered (declared → registered): owner Payments (team)");
    expect(decisionLine({ action: "merge", from: "registered", to: "registered", by: "u3", at, details: { merged_from: "billing-v1" } })).toBe(
      "u3 merged: took in billing-v1",
    );
    expect(decisionLine({ action: "publish", from: "registered", to: "published", by: "u3", at, details: { version: "1.0.0" } })).toBe(
      "u3 published (registered → published): version 1.0.0",
    );
  });

  it("says a refusal for a non-administrator in plain words", () => {
    expect(decisionRefusal(403, "HTTP 403 · Forbidden")).toContain("Only an organization administrator");
    expect(decisionRefusal(400, "a `declared` entry cannot be moved by `publish`")).toBe(
      "a `declared` entry cannot be moved by `publish`",
    );
  });
});
