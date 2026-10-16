// The project's glossary, as a person works through it: what each word means,
// which two words are probably one thing, which words nobody has defined.
// Pure: glossary-screen.tsx draws what these compute.

import { layerOf, type Layer } from "./domain-layers";
import type { Entity, GlossaryEntry, SpecModelFact } from "./spec-model";

export type GlossaryFilter = "all" | "undefined" | "similar" | "named";

/** One row of the glossary, with what the model knows of the word. */
export interface GlossaryRow {
  entry: GlossaryEntry;
  /** What the documents say it is, when one of them does. */
  definition: string | null;
  layer: Layer | null;
  /** Every passage that says what it is, each from its document: the one the
   *  definition is read from first. */
  definitions: SpecModelFact[];
  /** The documents it is said in. */
  paths: string[];
}

/** Each entry with its definition and layer, read off the model's entities. */
export function glossaryRows(entries: GlossaryEntry[], entities: Entity[]): GlossaryRow[] {
  const byKey = new Map<string, Entity>();
  for (const e of entities) for (const k of e.keys) byKey.set(k, e);
  return entries.map((entry) => {
    const e = byKey.get(entry.key);
    const definitions = e?.facts.filter((f) => f.kind === "entity") ?? [];
    const paths = [...new Set((e?.facts ?? []).map((f) => f.source.path))];
    return { entry, definition: definitions[0]?.text ?? null, layer: e ? layerOf(e) : null, definitions, paths };
  });
}

/** Two entries that are probably one thing, and why it looks so. */
export interface SimilarPair {
  a: GlossaryEntry;
  b: GlossaryEntry;
  why: string;
  /** How the names are alike: one is the other with an ending, or with a
   *  level in front. What a clarifying sentence says depends on it. */
  how?: { suffix: string } | { level: string };
}

/** A sentence that tells the two words apart, for the document that
 *  describes the longer one; a person corrects it before it is proposed. */
export function clarifySentence(p: SimilarPair): string {
  const [base, longer] = p.b.key.length >= p.a.key.length ? [p.a, p.b] : [p.b, p.a];
  const subject = longer.name.charAt(0).toUpperCase() + longer.name.slice(1);
  const article = /^[aeiou]/i.test(longer.name) ? "An" : "A";
  if (p.how && "level" in p.how) return `${subject} is a **${base.name}** at the ${p.how.level} level.`;
  if (p.how && p.how.suffix === "ship") return `${article} ${longer.name} is what makes someone a **${base.name}**.`;
  return `${subject} is not the same as **${base.name}**: …`;
}

const words = (key: string) => key.split(" ").filter(Boolean);
/** Levels a word can be qualified by without becoming another thing. */
// Not "studio": "studio-tasks" is a gear, not the task said more fully.
const SCOPES = new Set(["organization", "workspace", "project", "platform"]);

/** Pairs of entries that look like one thing under two names: one is the
 *  other with "-ship"/"-s"/"-ing" on it (member, membership), or one is the
 *  other with its level in front (membership, organization membership).
 *  Only entries the documents say something real about, the busiest first. */
export function similarPairs(entries: GlossaryEntry[], max = 40): SimilarPair[] {
  const pool = entries.filter((e) => e.facts >= 2 && e.key.length >= 4);
  // A pair a member said is two things is not offered again.
  const apart = (a: GlossaryEntry, b: GlossaryEntry) => !!a.distinct_from?.includes(b.key) || !!b.distinct_from?.includes(a.key);
  const byKey = new Map(pool.map((e) => [e.key, e]));
  const out: SimilarPair[] = [];
  const seen = new Set<string>();
  const add = (a: GlossaryEntry, b: GlossaryEntry, why: string, how: SimilarPair["how"]) => {
    const id = [a.key, b.key].sort().join("|");
    if (a.key === b.key || seen.has(id) || apart(a, b)) return;
    seen.add(id);
    out.push(a.facts >= b.facts ? { a, b, why, how } : { a: b, b: a, why, how });
  };
  for (const e of pool) {
    for (const suffix of ["ship", "s", "ing"]) {
      const other = byKey.get(e.key + suffix);
      if (other) add(e, other, `“${other.name}” is “${e.name}” with “-${suffix}”`, { suffix });
    }
    // "Organization membership" is the membership; "nested project" is a kind
    // of project, not another name for it. Only a level in front reads as the
    // same thing said more fully.
    const w = words(e.key);
    if (w.length === 2 && SCOPES.has(w[0])) {
      const tail = byKey.get(w[1]);
      if (tail) add(tail, e, `“${e.name}” names “${tail.name}” with its level`, { level: w[0] });
    }
  }
  return out.sort((x, y) => y.a.facts + y.b.facts - (x.a.facts + x.b.facts)).slice(0, max);
}

/** The rows a filter and a search keep, the most described first. */
export function filterRows(rows: GlossaryRow[], filter: GlossaryFilter, text: string, similar: SimilarPair[]): GlossaryRow[] {
  const q = text.trim().toLowerCase();
  const inPairs = new Set(similar.flatMap((p) => [p.a.key, p.b.key]));
  return rows
    .filter((r) => {
      if (filter === "undefined") return !r.definition && r.layer !== null;
      if (filter === "similar") return inPairs.has(r.entry.key);
      if (filter === "named") return r.entry.chosen || r.entry.aliases.length > 0;
      return true;
    })
    .filter((r) => !q || r.entry.name.toLowerCase().includes(q) || r.entry.spellings.some((s) => s.toLowerCase().includes(q)) || (r.definition ?? "").toLowerCase().includes(q))
    .sort((a, b) => b.entry.facts - a.entry.facts || a.entry.name.localeCompare(b.entry.name));
}

/** What to merge an entry into: the entries a search names, the busiest
 *  first, never itself or one already merged into it. */
export function mergeCandidates(entry: GlossaryEntry, entries: GlossaryEntry[], text: string, max = 8): GlossaryEntry[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const own = new Set([entry.key, ...entry.aliases.map((a) => a.key)]);
  return entries
    .filter((e) => !own.has(e.key) && (e.name.toLowerCase().includes(q) || e.spellings.some((s) => s.toLowerCase().includes(q))))
    .sort((a, b) => b.facts - a.facts)
    .slice(0, max);
}

/** A rename to offer to carry into the documents once `entry` is called
 *  `to`: from the name the documents use for it (a member's earlier choice is
 *  not in them), or null when that is the same word. */
export function renameOffer(entry: GlossaryEntry, to: string): { from: string; to: string } | null {
  const name = to.trim();
  if (!name) return null;
  const from = entry.chosen ? (entry.spellings.find((s) => s.toLowerCase() !== name.toLowerCase()) ?? entry.name) : entry.name;
  return from.toLowerCase() === name.toLowerCase() ? null : { from, to: name };
}

/** What to do with two names that look like one thing. */
export type PairAction = "same" | "clarify" | "different";

export interface PairVerdict {
  action: PairAction;
  /** Why, in a sentence a person can check against the evidence. */
  why: string;
  /** What the evidence is: how much each is said, where, and whether they meet. */
  evidence: { aFacts: number; bFacts: number; aDocs: number; bDocs: number; shared: number; aDefined: boolean; bDefined: boolean };
}

/** A recommendation for a pair, from how the names are alike and what the
 *  documents say of each. Never a decision: the person takes it or not.
 *  - "-ing" of the same word is the act and the thing done: one thing.
 *  - "-s" is a plural: one thing.
 *  - "-ship" names a standing, not the one who holds it (membership, member):
 *    two things worth telling apart in the documents.
 *  - A level in front with a definition of its own that says something else
 *    is a kind of the other: tell them apart. Without a definition of its own,
 *    said in the same documents, it is the other said more fully: one thing.
 *    Said in other documents altogether, with definitions of both: different. */
export function pairVerdict(p: SimilarPair, rowOf: (key: string) => GlossaryRow | undefined): PairVerdict {
  const a = rowOf(p.a.key);
  const b = rowOf(p.b.key);
  const aPaths = new Set(a?.paths ?? []);
  const shared = (b?.paths ?? []).filter((x) => aPaths.has(x)).length;
  const evidence = {
    aFacts: p.a.facts,
    bFacts: p.b.facts,
    aDocs: a?.paths.length ?? p.a.documents,
    bDocs: b?.paths.length ?? p.b.documents,
    shared,
    aDefined: !!a?.definitions.length,
    bDefined: !!b?.definitions.length,
  };
  const longer = p.b.key.length >= p.a.key.length ? { e: p.b, row: b, defined: evidence.bDefined } : { e: p.a, row: a, defined: evidence.aDefined };
  const base = longer.e === p.b ? { e: p.a, defined: evidence.aDefined } : { e: p.b, defined: evidence.bDefined };
  if (p.how && "suffix" in p.how) {
    if (p.how.suffix === "ing")
      return { action: "same", why: `“${longer.e.name}” is the act of “${base.e.name}”: one thing, named two ways.`, evidence };
    if (p.how.suffix === "s") return { action: "same", why: `“${longer.e.name}” is the plural of “${base.e.name}”.`, evidence };
    return {
      action: "clarify",
      why: `“${longer.e.name}” names the standing, “${base.e.name}” the one who holds it: two things the documents should tell apart.`,
      evidence,
    };
  }
  if (p.how && "level" in p.how) {
    if (longer.defined && base.defined)
      return shared === 0
        ? { action: "different", why: `Both are defined, and never in the same document: “${longer.e.name}” is its own thing.`, evidence }
        : { action: "clarify", why: `Both are defined: “${longer.e.name}” is a kind of “${base.e.name}” at the ${p.how.level} level — say so where it is defined.`, evidence };
    if (!longer.defined && shared > 0)
      return { action: "same", why: `“${longer.e.name}” has no definition of its own and is said in ${shared} of the same documents: “${base.e.name}”, said more fully.`, evidence };
    return { action: "clarify", why: `“${longer.e.name}” is said apart from “${base.e.name}” and nothing defines how they differ: one sentence settles it.`, evidence };
  }
  return { action: "clarify", why: "The names are alike and nothing says how they differ.", evidence };
}
