/* The matcher answers "what can we build this from?", and the answer has to be
 * buildable. Interviewing Acronis (2026-09-18) the gap was named while reading
 * the repository on screen: a gear directory with docs and a manifest and no
 * implementation still counts as a gear everywhere that counts gears. On the
 * local stand ten of forty-two Rust gears have `crates: 0` — `approval-service`
 * among them — so this is a state the ranking meets constantly, not a corner.
 *
 * What is pinned here is therefore the ordering (a stub must not displace a
 * shipped component) and the three things `null` must not become.
 */
import { describe, expect, it } from "vitest";

import type { CatalogNode, Capability } from "./api";
import { buildState, buildStateOf, composabilityOf, composePlan, profilesByName } from "./compose";

const node = (name: string, description: string, kind = "gear"): CatalogNode => ({
  type_id: "gear",
  instance_id: name,
  value: { name, description, kind },
});

/** A profile as the repository scan writes it: `auto.crates.n` is the crate
 *  count under the component's directory. */
const profile = (gear_name: string, crates: number | null) => ({
  type_id: "profile",
  instance_id: gear_name,
  value: {
    gear_name,
    auto: crates === null ? {} : { crates: { n: crates, v: String(crates), b: String(crates) } },
  },
}) as unknown as CatalogNode;

const vocab: Capability[] = [{ key: "billing", label: "Billing", terms: ["billing"], owner: "builtin" }];

describe("buildState", () => {
  it("reads the crate count the repository scan recorded", () => {
    expect(buildState({ auto: { crates: { n: 2 } } })).toBe("built");
    expect(buildState({ auto: { crates: { n: 0 } } })).toBe("docs-only");
  });

  it("says nothing when it was not asked, rather than guessing", () => {
    // A FrontX package carries no crate count; a component nobody scanned has
    // no profile at all. Neither is evidence that nothing was built.
    expect(buildState(undefined)).toBeNull();
    expect(buildState({})).toBeNull();
    expect(buildState({ auto: {} })).toBeNull();
    expect(buildState({ auto: { crates: {} } })).toBeNull();
  });
});

describe("buildStateOf", () => {
  const withStatus = (status?: string): CatalogNode => ({
    type_id: "gear",
    instance_id: "x",
    value: status === undefined ? { name: "x" } : { name: "x", status },
  });

  it("takes the catalogue's own word when it has one", () => {
    // The server computes this during the scan now, so every consumer gets one
    // answer instead of each deriving its own.
    expect(buildStateOf(withStatus("draft"))).toBe("docs-only");
    expect(buildStateOf(withStatus("published"))).toBe("built");
  });

  it("outranks the profile, which is the older way of asking", () => {
    const built = profilesByName([profile("x", 3)])["x"];
    expect(buildStateOf(withStatus("draft"), built)).toBe("docs-only");
  });

  it("falls back to the crate count for a graph synced before the status", () => {
    expect(buildStateOf(withStatus(), profilesByName([profile("x", 2)])["x"])).toBe("built");
    expect(buildStateOf(withStatus(), profilesByName([profile("x", 0)])["x"])).toBe("docs-only");
  });

  it("says nothing when neither the node nor a profile knows", () => {
    expect(buildStateOf(withStatus())).toBeNull();
  });

  it("ignores a status word this build does not know", () => {
    // `certified` is a rung the backend cannot compute yet; a build that meets
    // one must not read it as an assessment it did not make.
    expect(buildStateOf(withStatus("certified"))).toBeNull();
  });
});

describe("composePlan", () => {
  it("puts a built component above a stub that matched more words", () => {
    // The stub wins on keywords — it says "billing" three ways — and that is
    // exactly the failure: prose is what a docs-only directory has most of.
    const gears = [
      node("cf-gears-stub", "billing, billing engine, billing ledger"),
      node("cf-gears-real", "billing"),
    ];
    const profiles = profilesByName([profile("cf-gears-stub", 0), profile("cf-gears-real", 3)]);
    const [row] = composePlan(["billing"], gears, profiles, vocab);
    expect(row.candidates.map((c) => c.name)).toEqual(["cf-gears-real", "cf-gears-stub"]);
    expect(row.candidates[0].built).toBe("built");
    expect(row.candidates[1].built).toBe("docs-only");
  });

  it("keeps a built component in the top five when stubs would have filled it", () => {
    const gears = [
      ...["a", "b", "c", "d", "e"].map((s) => node(`stub-${s}`, "billing billing billing")),
      node("real", "billing"),
    ];
    const profiles = profilesByName([
      ...["a", "b", "c", "d", "e"].map((s) => profile(`stub-${s}`, 0)),
      profile("real", 1),
    ]);
    const [row] = composePlan(["billing"], gears, profiles, vocab);
    expect(row.candidates).toHaveLength(5);
    expect(row.candidates[0].name).toBe("real");
  });

  it("ranks an unscanned component between built and docs-only", () => {
    // Not knowing is not the same as knowing there is nothing.
    const gears = [node("unknown", "billing"), node("stub", "billing"), node("real", "billing")];
    const profiles = profilesByName([profile("stub", 0), profile("real", 1)]);
    const [row] = composePlan(["billing"], gears, profiles, vocab);
    expect(row.candidates.map((c) => c.name)).toEqual(["real", "unknown", "stub"]);
    expect(row.candidates[1].built).toBeNull();
  });

  it("flags a capability whose every candidate is a stub, without calling it a gap", () => {
    const gears = [node("stub-one", "billing"), node("stub-two", "billing")];
    const profiles = profilesByName([profile("stub-one", 0), profile("stub-two", 0)]);
    const [row] = composePlan(["billing"], gears, profiles, vocab);
    expect(row.gap).toBe(false);
    expect(row.unbuilt).toBe(true);
  });

  it("does not call a capability unbuilt when one candidate was never scanned", () => {
    const gears = [node("stub", "billing"), node("unknown", "billing")];
    const [row] = composePlan(["billing"], gears, profilesByName([profile("stub", 0)]), vocab);
    expect(row.unbuilt).toBe(false);
  });

  it("offers one component once, however many times the catalogue stores it", () => {
    // Sixteen of 118 names on the local stand are stored under two GTS types —
    // the same FrontX package as `catalog.frontx.v1` and `catalog.gear.v1`. A
    // list of five that spends two slots on one package is a list of four.
    const gears = [
      node("@gears-frontx/state", "billing state", "frontx"),
      node("@gears-frontx/state", "billing state", "frontx"),
      node("cf-gears-real", "billing"),
    ];
    const [row] = composePlan(["billing"], gears, {}, vocab);
    expect(row.candidates.map((c) => c.name)).toEqual(["@gears-frontx/state", "cf-gears-real"]);
  });

  it("keeps the better-ranked copy of a duplicated component", () => {
    const gears = [node("dup", "billing"), node("dup", "billing billing")];
    const profiles = profilesByName([profile("dup", 2)]);
    const [row] = composePlan(["billing"], gears, profiles, vocab);
    expect(row.candidates).toHaveLength(1);
    expect(row.candidates[0].score).toBe(1);
  });

  it("ignores a term swallowed by the end of a longer word", () => {
    // Every false positive measured on the live catalogue was this shape:
    // `rating` in "integrating", `source` in "resource", `file` in "profile",
    // `entity` in "machine-identity", `graph` in "cryptography".
    const cases: [string, string][] = [
      ["rating", "FrontX framework integrating all SDK packages"],
      ["source", "resource group manager"],
      ["file", "registers per-profile primitives"],
      ["entity", "machine-identity lifecycle"],
      ["graph", "cryptography provider"],
    ];
    for (const [cap, description] of cases) {
      const [row] = composePlan([cap], [node("thing", description)], {}, []);
      expect(row.gap, `${cap} should not match "${description}"`).toBe(true);
    }
  });

  it("matches a term that begins a longer word", () => {
    // And every genuine match lost to a both-ends anchor was this shape, which
    // is why only the head is anchored.
    const cases: [string, string][] = [
      ["deploy", "composite module deployment-topology"],
      ["node", "cf-gears-nodes-registry"],
      ["subscription", "subscriptions and renewals"],
    ];
    for (const [cap, description] of cases) {
      const [row] = composePlan([cap], [node("thing", description)], {}, []);
      expect(row.gap, `${cap} should match "${description}"`).toBe(false);
    }
  });

  it("treats a hyphen, a slash and an @ as the start of a word", () => {
    for (const name of ["cf-gears-file-storage", "@gears-frontx/storage"]) {
      const [row] = composePlan(["storage"], [node(name, "")], {}, []);
      expect(row.candidates.map((c) => c.name), name).toEqual([name]);
    }
  });

  it("does not let a capability term break the expression it is put into", () => {
    // Terms come from a workspace's own vocabulary, so they are arbitrary text.
    const vocabulary: Capability[] = [
      { key: "odd", label: "Odd", terms: ["c++", "a(b"], owner: "workspace" },
    ];
    const [row] = composePlan(["odd"], [node("thing", "written in c++")], {}, vocabulary);
    expect(row.candidates.map((c) => c.name)).toEqual(["thing"]);
  });

  it("still reports a real gap as a gap", () => {
    const [row] = composePlan(["billing"], [node("search", "full text search")], {}, vocab);
    expect(row.gap).toBe(true);
    expect(row.unbuilt).toBe(false);
    expect(row.candidates).toEqual([]);
  });

  it("matches an unknown capability against its own name, as before", () => {
    const gears = [node("cf-gears-ledger", "a ledger for postings")];
    const [row] = composePlan(["ledger"], gears, {}, vocab);
    expect(row.candidates.map((c) => c.name)).toEqual(["cf-gears-ledger"]);
    expect(row.candidates[0].why).toContain("ledger");
  });
});

describe("profilesByName", () => {
  it("keys by gear_name and ignores nodes that carry none", () => {
    const map = profilesByName([
      profile("cf-gears-ledger", 1),
      { type_id: "x", instance_id: "y", value: {} } as CatalogNode,
    ]);
    expect(Object.keys(map)).toEqual(["cf-gears-ledger"]);
  });
});

/* What the Gearbox engine said, as the catalogue sync writes it into the
 * profile: `auto.gdl_runs`. A suggestion should lead with what can go into a
 * product and leave what the engine proved cannot run for last. */
describe("composability", () => {
  const withRuns = (gear_name: string, s: "good" | "bad", v = s === "good" ? "yes" : "no — must run with cf-gears-authz-resolver") =>
    ({
      type_id: "profile",
      instance_id: gear_name,
      value: { gear_name, auto: { crates: { n: 1 }, gdl_runs: { v, b: v, s } } },
    }) as unknown as CatalogNode;

  it("reads the engine's verdict and its reason", () => {
    expect(composabilityOf(undefined).state).toBeNull();
    expect(composabilityOf({ auto: { gdl_runs: { v: "yes", s: "good" } } }).state).toBe("runs");
    expect(composabilityOf({ auto: { gdl_runs: { v: "no — needs mode", s: "bad" } } })).toEqual({
      state: "blocked",
      why: "needs mode",
    });
  });

  it("puts a gear that can run ahead of one that cannot, at the same build state", () => {
    const gears = [
      node("cf-gears-resource-group", "billing resource groups"),
      node("cf-gears-plain", "billing"),
      node("cf-gears-tenant-resolver", "billing tenants"),
    ];
    const profiles = profilesByName([
      withRuns("cf-gears-resource-group", "bad"),
      profile("cf-gears-plain", 1),
      withRuns("cf-gears-tenant-resolver", "good"),
    ]);
    const [row] = composePlan(["billing"], gears, profiles, vocab);
    expect(row!.candidates.map((c) => c.name)).toEqual([
      "cf-gears-tenant-resolver",
      "cf-gears-plain",
      "cf-gears-resource-group",
    ]);
    expect(row!.candidates[2]!.composableWhy).toBe("must run with cf-gears-authz-resolver");
  });
});
