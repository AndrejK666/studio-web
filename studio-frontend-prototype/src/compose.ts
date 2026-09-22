//! Match what a product needs against the components this system knows.
//!
//! Shared by the App Spec's Compose button and the project's Components tab,
//! which ask the same question from two directions and must not answer it two
//! ways.
//!
//! ── Why a candidate carries whether it was ever built ─────────────────────────
//!
//! A gear directory in the catalogue is not a gear. Interviewing Acronis
//! (2026-09-18) the point was made while reading the repository listing on
//! screen — "тут есть документы, дизайн, но ничего нету, реализации никакой
//! нет. Вот как это считать?" — against a roadmap number roughly five times the
//! count of gears anyone has finished.
//!
//! That is not a complaint about the catalogue, it is a defect in any tool that
//! reads it. Ranking by keyword alone puts a well-written stub above a shipped
//! component, because a stub is mostly prose and prose is what the keywords
//! match. Suggesting it is worse than suggesting nothing: it answers "what can
//! we build this from?" with something nobody can build from.
//!
//! The catalogue already knows. The repository scan counts the crates under a
//! gear's directory (`components_catalog/repo_enrich.rs`), and on this stand ten
//! of forty-two Rust gears count zero — `approval-service` among them, which is
//! one of the two he named. So candidates are sorted built-first and the rest
//! are labelled, rather than quietly dropped: a design may legitimately name a
//! component that is still only a design.

import type { CatalogNode, Capability } from "./api";

/** What the catalogue can say about whether a component was ever built.
 *
 *  `null` is not a maybe — it means the question does not apply or was never
 *  asked. FrontX packages carry no crate count at all, and a component with no
 *  profile has not been scanned. Neither is evidence of absence, so neither is
 *  reported as one. */
export type BuildState = "built" | "docs-only" | null;

export type Candidate = {
  name: string;
  kind: string;
  score: number;
  why: string[];
  built: BuildState;
};

export type PlanRow = {
  capability: string;
  candidates: Candidate[];
  /** No candidate at all — the capability has nothing to build from. */
  gap: boolean;
  /** Candidates exist, but none of them has been built. Not a gap, and not an
   *  answer either: worth saying out loud rather than leaving to the reader. */
  unbuilt: boolean;
};

function profileText(profile?: Record<string, unknown>): string {
  const auto = profile?.auto;
  if (auto && typeof auto === "object") {
    const d = (auto as Record<string, unknown>).description;
    if (d && typeof d === "object") {
      const s = (d as Record<string, unknown>).s;
      if (typeof s === "string") return s;
    }
    if (typeof d === "string") return d;
  }
  return "";
}

/** Crates under the component's directory, as the repository scan counted them.
 *
 *  Read from `auto.crates.n`, which the scan writes for a Rust gear and omits
 *  for anything it did not scan that way. Zero is the load-bearing value: a
 *  directory holding `docs/` and `gear.toml` and no crate. */
export function buildState(profile?: Record<string, unknown>): BuildState {
  const auto = profile?.auto;
  if (!auto || typeof auto !== "object") return null;
  const crates = (auto as Record<string, unknown>).crates;
  if (!crates || typeof crates !== "object") return null;
  const n = (crates as Record<string, unknown>).n;
  if (typeof n !== "number") return null;
  return n > 0 ? "built" : "docs-only";
}

/** Does the text mention `term` where a word begins?
 *
 *  `includes` was the old test, and on the live catalogue it offered
 *  `@gears-frontx/framework` for the `rating` capability — because its
 *  description says "FrontX framework integ**rating** all SDK packages". A
 *  suggestion list is a claim that these components fit, and a coincidence of
 *  spelling is the cheapest possible way to break that claim.
 *
 *  Only the START of the term is anchored, which is not the obvious rule and is
 *  the one the catalogue asked for. Every false positive measured there was the
 *  term swallowed by the END of a longer word — `source` in "resource", `file`
 *  in "profile", `entity` in "machine-identity", `graph` in "cryptography".
 *  Every genuine match lost to a both-ends anchor was the term BEGINNING one —
 *  `deploy` in "deployment-topology", `node` in "nodes-registry",
 *  `subscription` in "subscriptions". Anchoring the head alone keeps the second
 *  set and drops the first.
 *
 *  The boundary is "not a letter or digit" rather than `\b`, so a hyphen, a
 *  slash and an `@` all start a word: `storage` finds `cf-gears-file-storage`
 *  and `state` finds `@gears-frontx/state`. */
function mentions(hay: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}`).test(hay);
}

function componentHaystack(g: CatalogNode, profile?: Record<string, unknown>): string {
  const v = g.value;
  return [
    v.name ?? "",
    v.description ?? "",
    v.kind ?? "",
    (v.keywords ?? []).join(" "),
    (v.categories ?? []).join(" "),
    profileText(profile),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Resolve capabilities to candidate components.
 *
 *  `vocabulary` is the workspace's effective capability catalogue, which used to
 *  be a `CAP_KEYWORDS` constant in this file. A workspace that invents a
 *  capability can now give it search terms instead of getting zero candidates
 *  and no explanation (ADR-0014 s5). A capability the catalogue does not know is
 *  still matched against its own name, exactly as before.
 *
 *  Candidates come back built-first, then by score. The cut to five happens
 *  after that sort, so a shipped component is never displaced from the list by
 *  a stub that mentioned the word more often. */
export function composePlan(
  caps: string[],
  gears: CatalogNode[],
  profiles: Record<string, Record<string, unknown>>,
  vocabulary: readonly Capability[],
): PlanRow[] {
  const terms = new Map(vocabulary.map((c) => [c.key, c.terms]));
  const geared = gears.filter((g) => typeof g.value.name === "string");
  const rank = (c: Candidate) => (c.built === "built" ? 0 : c.built === null ? 1 : 2);
  return caps.map((cap) => {
    const kws = terms.get(cap)?.length ? terms.get(cap)! : [cap];
    const candidates = geared
      .map((g) => {
        const profile = profiles[g.value.name as string];
        const hay = componentHaystack(g, profile);
        const why = new Set<string>();
        for (const k of kws) if (mentions(hay, k)) why.add(k);
        if (mentions(hay, cap)) why.add(cap);
        return {
          name: g.value.name as string,
          kind: g.value.kind ?? "gear",
          score: why.size,
          why: Array.from(why),
          built: buildState(profile),
        };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => rank(a) - rank(b) || b.score - a.score)
      // One component, one candidate. Sixteen of the 118 names on this stand are
      // stored twice -- the same FrontX package under both
      // `catalog.frontx.v1` and `catalog.gear.v1` -- and a list of five that
      // spends two slots on one package is offering four. Deduplication comes
      // after the sort, so the copy that survives is the better-ranked one.
      .filter((c, i, all) => all.findIndex((o) => o.name === c.name) === i)
      .slice(0, 5);
    return {
      capability: cap,
      candidates,
      gap: candidates.length === 0,
      unbuilt: candidates.length > 0 && candidates.every((c) => c.built === "docs-only"),
    };
  });
}

/** The profiles keyed the way `composePlan` wants them: by component name.
 *
 *  Both callers were doing this inline, and one of them reading `gear_name` off
 *  a node whose other half is a `uml` array is not obvious enough to write
 *  twice. */
export function profilesByName(nodes: CatalogNode[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const n of nodes) {
    const name = (n.value as Record<string, unknown>).gear_name;
    if (typeof name === "string") out[name] = n.value as Record<string, unknown>;
  }
  return out;
}
