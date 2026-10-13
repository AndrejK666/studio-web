// The Domain model tab's arithmetic: a project's facts folded into entities,
// its findings put in the order a person works through them, and where its
// documents stand. Pure, so the screen only draws.
//
// The facts come from `GET /studio-documents/v1/spec-model`
// (docs/spec-domain-model.md); the folding here matches the backend's
// `rules::subject_key`, so the entity a person opens holds the same facts the
// rules compared.

export interface SpecModelSide {
  path: string;
  line_start?: number | null;
  line_end?: number | null;
  quote?: string | null;
}

export type FactKind =
  | "entity"
  | "attribute"
  | "relation"
  | "requirement"
  | "constraint"
  | "lifecycle"
  | "decision";

export type FactStatus = "active" | "proposed" | "deferred" | "superseded" | "resolved" | "evidence";

export interface SpecModelFact {
  kind: FactKind;
  subject: string;
  aspect: string;
  value: string;
  text: string;
  status: FactStatus;
  status_because: string;
  source: SpecModelSide;
}

export interface SpecModelDocument {
  path: string;
  revision: string;
  state: "extracted" | "failed" | "stale" | "pending";
  facts: number;
  dropped: number;
  error?: string | null;
}

export interface SpecModelBuild {
  running: boolean;
  documents: number;
  done: number;
  candidates: number;
  judged: number;
  current?: string | null;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface SpecModel {
  build: SpecModelBuild;
  documents: SpecModelDocument[];
  facts: SpecModelFact[];
}

export interface SpecModelFinding {
  fingerprint: string;
  rule: string;
  severity: "high" | "medium" | "low";
  message: string;
  sides: SpecModelSide[];
  decide: string[];
  edit?: { path: string; replace: string; with: string } | null;
  decision?: "confirmed" | "dismissed" | null;
}

/** A subject folded so two spellings of one thing meet: case, articles,
 *  punctuation and a plural `s` do not count. The backend's `subject_key`. */
export function subjectKey(subject: string): string {
  return subject
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && w !== "the" && w !== "a" && w !== "an")
    .map((w) => (w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w))
    .join(" ");
}

export interface Entity {
  key: string;
  /** The spelling the documents use most. */
  name: string;
  facts: SpecModelFact[];
  /** Documents that say something about it. */
  documents: number;
  /** Facts in force. */
  active: number;
}

/** The model's subjects, each with every fact about it, the most described
 *  first. Relations and attributes hang off their subject; a subject that is
 *  only ever a decision is left out, since a decision is not part of the
 *  application. */
export function entitiesOf(facts: SpecModelFact[]): Entity[] {
  const byKey = new Map<string, { spellings: Map<string, number>; facts: SpecModelFact[] }>();
  for (const fact of facts) {
    const key = subjectKey(fact.subject);
    if (!key) continue;
    const group = byKey.get(key) ?? { spellings: new Map<string, number>(), facts: [] as SpecModelFact[] };
    group.spellings.set(fact.subject, (group.spellings.get(fact.subject) ?? 0) + 1);
    group.facts.push(fact);
    byKey.set(key, group);
  }
  const out: Entity[] = [];
  for (const [key, group] of byKey) {
    if (group.facts.every((f) => f.kind === "decision")) continue;
    const name = [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    out.push({
      key,
      name,
      facts: group.facts,
      documents: new Set(group.facts.map((f) => f.source.path)).size,
      active: group.facts.filter((f) => f.status === "active").length,
    });
  }
  return out.sort((a, b) => b.facts.length - a.facts.length || a.name.localeCompare(b.name));
}

/** The facts the documents give about one entity, in the order a reader
 *  wants them: what it is, what it has, what it relates to, what must hold,
 *  how it lives, and what is required of it. */
export const KIND_ORDER: FactKind[] = [
  "entity",
  "attribute",
  "relation",
  "constraint",
  "lifecycle",
  "requirement",
  "decision",
];

export function factsByKind(facts: SpecModelFact[]): { kind: FactKind; facts: SpecModelFact[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, facts: facts.filter((f) => f.kind === kind) })).filter(
    (g) => g.facts.length > 0,
  );
}

/** The other entities an entity relates to, by the relation facts whose value
 *  names one of them. */
export function relatedEntities(entity: Entity, all: Entity[]): string[] {
  const keys = new Set(all.map((e) => e.key));
  const out = new Set<string>();
  for (const fact of entity.facts) {
    if (fact.kind !== "relation") continue;
    const target = subjectKey(fact.value);
    for (const key of keys) {
      if (key !== entity.key && target.includes(key)) out.add(key);
    }
  }
  return [...out];
}

const SEVERITY: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Findings in the order a person works through them: undecided first, then
 *  confirmed, dismissed last; within each, high before medium before low,
 *  and disagreements before references. */
export function orderFindings(findings: SpecModelFinding[]): SpecModelFinding[] {
  const decided = (f: SpecModelFinding) =>
    f.decision === "dismissed" ? 2 : f.decision === "confirmed" ? 1 : 0;
  const family = (f: SpecModelFinding) => (f.rule.startsWith("reference.") ? 1 : 0);
  return [...findings].sort(
    (a, b) =>
      decided(a) - decided(b) ||
      (SEVERITY[a.severity] ?? 3) - (SEVERITY[b.severity] ?? 3) ||
      family(a) - family(b) ||
      a.rule.localeCompare(b.rule),
  );
}

/** What a rule is called on the screen. */
export function ruleLabel(rule: string): string {
  const labels: Record<string, string> = {
    "contradiction.value": "Two values",
    "contradiction.cardinality": "Cardinality",
    "contradiction.lifecycle": "Lifecycle",
    "contradiction.access": "Access",
    "contradiction.decision": "Against a decision",
    "stale.superseded": "Describes what was replaced",
    "reference.dangling": "Refers to nothing",
    "reference.ambiguous": "Ambiguous reference",
    "reference.misattributed": "Wrong record cited",
    "product.missing": "Not in the code",
    "product.decided_not_built": "Decided, not built",
  };
  return labels[rule] ?? rule;
}

/** A document a product finding sits on (`GET /studio-spec-mapping/v1/findings`). */
export interface ProductSide {
  /** `file`: a repository path; `document`: a Studio document's title. */
  kind: "file" | "document";
  path: string;
  quote: string;
}

/** What the project's documents ask for that its code is not made of. */
export interface ProductFinding {
  fingerprint: string;
  rule: "product.missing" | "product.decided_not_built";
  severity: "high" | "medium";
  capability: string;
  gear?: string | null;
  message: string;
  sides: ProductSide[];
  candidates: string[];
}

/** Product findings high first, then by capability. */
export function orderProductFindings(findings: ProductFinding[]): ProductFinding[] {
  const rank = (f: ProductFinding) => (f.severity === "high" ? 0 : 1);
  return [...findings].sort((a, b) => rank(a) - rank(b) || a.capability.localeCompare(b.capability));
}

/** How many documents are in each state. */
export function coverageCounts(documents: SpecModelDocument[]): Record<SpecModelDocument["state"], number> {
  const counts = { extracted: 0, failed: 0, stale: 0, pending: 0 };
  for (const d of documents) counts[d.state] += 1;
  return counts;
}

/** One line about the build: what it is doing, or how it ended. */
export function buildLine(build: SpecModelBuild): string {
  if (build.running) {
    if (build.candidates > 0 || build.done >= build.documents) {
      return `Checking disagreements ${build.judged}/${build.candidates}`;
    }
    return `Reading documents ${build.done}/${build.documents}${build.current ? ` · ${build.current}` : ""}`;
  }
  if (build.error) return `Stopped: ${build.error}`;
  if (build.finished_at) return `Built ${build.done} document(s), checked ${build.judged} candidate(s)`;
  return "";
}

/** A message cut where the backend quoted a name in backticks, so the screen
 *  sets those parts as code rather than printing the backticks. An unpaired
 *  backtick stays as written. */
export function codeSpans(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) });
    out.push({ code: true, text: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) });
  return out;
}

/** "path:12-14", or the path alone for a whole document. */
export function sideLabel(side: SpecModelSide): string {
  if (!side.line_start) return side.path;
  return side.line_end && side.line_end !== side.line_start
    ? `${side.path}:${side.line_start}-${side.line_end}`
    : `${side.path}:${side.line_start}`;
}
