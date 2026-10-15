// What would make the documentation better, each with the change ready to
// save: the "To resolve" queue's second half. A finding says the documents
// disagree; these say they are thin where a reader needs them:
//
// - No definition: a thing of the domain the documents say plenty about,
//   but never what it is. The sentence is put together from what they say.
// - Two names for one thing: the glossary's similar pairs, settled in one
//   click the way the Glossary settles them.
// - One-sided relation: A says it relates to B, and B never mentions A. A
//   reader who starts at B does not learn of it.
// - Only in an ADR or a feature: a thing of the domain no requirement or
//   domain document describes, so it is part of the product only by
//   accident of a decision or a feature write-up.
//
// Each save writes the entity's section of docs/domain-model.md through the
// same call the model map's editor uses. Pure: domain-model-screens.tsx
// draws what these compute.

import type { SpecModelEntityEdit } from "./api";
import { cardFields, entityDraft, isTemplatePath, layerOf, relationTarget } from "./domain-layers";
import { similarPairs, type SimilarPair } from "./glossary-view";
import { subjectKey, type Entity, type GlossaryEntry, type SpecModelFact, type SpecModelSide } from "./spec-model";

export type DocQualityType = "nodefinition" | "twonames" | "onesided" | "onlyadr";

export const DOC_QUALITY_LABEL: Record<DocQualityType, string> = {
  onlyadr: "Only in an ADR or a feature",
  nodefinition: "No definition",
  onesided: "One-sided relation",
  twonames: "Two names for one thing",
};

export interface DocQualityItem {
  key: string;
  type: DocQualityType;
  title: string;
  /** What is thin, and what saving does, in a sentence. */
  hint: string;
  sides: SpecModelSide[];
  /** The entity's section as it would be saved; absent for two names. */
  edit?: SpecModelEntityEdit;
  /** For two names: the pair, the second to be read as the first. */
  pair?: SimilarPair;
}

/** A thing's facts that are about this project: a kit's templates and
 *  examples describe a document type. */
const own = (e: Entity) => e.facts.filter((f) => !isTemplatePath(f.source.path));

const article = (name: string) => (/^[aeiou]/i.test(name) ? "An" : "A");

/** "a, b and c". */
function listed(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** A sentence saying what an entity is, from what the documents say of it:
 *  what it holds and how it relates, else the first thing asked of it. A
 *  starting point a person corrects, not a definition the model vouches for. */
export function definitionFrom(e: Pick<Entity, "name" | "facts">): string {
  const fields = cardFields(e, 3);
  const relations = entityDraft(e).relations.slice(0, 2);
  const parts = [...(fields.length ? [`holds ${listed(fields)}`] : []), ...relations.map((r) => `${r.verb} ${r.target}`)];
  if (parts.length) return `${article(e.name)} ${e.name} ${listed(parts)}.`;
  const said = e.facts.find((f) => f.text.trim() && f.kind !== "decision") ?? e.facts.find((f) => f.text.trim());
  return said ? `${article(e.name)} ${e.name}: ${said.text.trim()}` : `${article(e.name)} ${e.name} is …`;
}

/** The places a thing is described, one per document, the first three. */
function sidesOf(facts: SpecModelFact[]): SpecModelSide[] {
  const out: SpecModelSide[] = [];
  for (const f of facts) if (!out.some((s) => s.path === f.source.path)) out.push(f.source);
  return out.slice(0, 3);
}

/** The relation as the other side would say it: if a project belongs to a
 *  workspace, the workspace has the project. Anything not known reads "has";
 *  the verb is editable before the save. */
export function inverseVerb(verb: string): string {
  const v = verb.trim().toLowerCase();
  const known: Record<string, string> = {
    "belongs to": "has",
    "is part of": "contains",
    "is in": "contains",
    contains: "is part of",
    includes: "is part of",
    has: "belongs to",
    "has many": "belongs to",
    "has one": "belongs to",
    owns: "is owned by",
    "is owned by": "owns",
    references: "is referenced by",
    "is referenced by": "references",
    uses: "is used by",
    "is used by": "uses",
    creates: "is created by",
    "is created by": "creates",
    manages: "is managed by",
    "is managed by": "manages",
  };
  return known[v] ?? "has";
}

const isDecisionOrFeature = (p: string) => /^docs\/(adr|features?)\//i.test(p);

/** Whether any of `facts` names `other`, by a relation to it or by its name
 *  in what a fact says. */
function mentions(facts: SpecModelFact[], other: Entity, of: Entity, all: Entity[]): boolean {
  for (const f of facts) {
    if (f.kind === "relation" && relationTarget(of, f, all)?.key === other.key) return true;
    const said = ` ${subjectKey(`${f.aspect} ${f.value} ${f.text}`)} `;
    if (other.keys.some((k) => said.includes(` ${k} `))) return true;
  }
  return false;
}

/** Everything that would make the documentation better, worst gap first:
 *  things only an ADR or a feature describes, things with no definition,
 *  one-sided relations, then words that may name one thing. */
export function docQuality(entities: Entity[], glossary: GlossaryEntry[] = []): DocQualityItem[] {
  const domain = entities.filter((e) => layerOf(e) === "domain");
  const onlyAdr: DocQualityItem[] = [];
  const noDef: DocQualityItem[] = [];
  const oneSided: DocQualityItem[] = [];

  for (const e of domain) {
    const facts = own(e);
    const definition = facts.find((f) => f.kind === "entity");
    if (facts.length > 0 && facts.every((f) => isDecisionOrFeature(f.source.path))) {
      const where = facts.some((f) => /^docs\/adr\//i.test(f.source.path)) ? "an ADR" : "a feature";
      onlyAdr.push({
        key: `oa:${e.key}`,
        type: "onlyadr",
        title: `${e.name} is described only in ${where}`,
        hint: "No requirement or domain document says it is part of the product. Add it to the domain model, with what it is.",
        sides: sidesOf(facts),
        edit: { ...entityDraft(e), definition: definition?.text.trim() || definitionFrom(e) },
      });
      continue;
    }
    if (!definition && facts.length >= 3) {
      noDef.push({
        key: `nd:${e.key}`,
        type: "nodefinition",
        title: `${e.name} has no definition`,
        hint: `${facts.length} facts describe it, but no document says what it is. Correct the sentence below and save it.`,
        sides: sidesOf(facts),
        edit: { ...entityDraft(e), definition: definitionFrom(e) },
      });
    }
  }

  const domainKeys = new Set(domain.map((e) => e.key));
  const seen = new Set<string>();
  for (const a of domain) {
    for (const f of own(a)) {
      if (f.kind !== "relation") continue;
      const b = relationTarget(a, f, entities);
      if (!b || !domainKeys.has(b.key)) continue;
      const id = `${a.key}>${b.key}`;
      if (seen.has(id) || seen.has(`${b.key}>${a.key}`)) continue;
      seen.add(id);
      if (mentions(own(b), a, b, entities)) continue;
      const draft = entityDraft(b);
      const verb = inverseVerb(f.aspect);
      oneSided.push({
        key: `os:${id}`,
        type: "onesided",
        title: `${a.name} ${f.aspect.trim() || "relates to"} ${b.name}, but ${b.name} never mentions ${a.name}`,
        hint: `Only one side of the relation is written down, so a reader who starts at ${b.name} does not learn of it. Add the other side to ${b.name}.`,
        sides: [f.source, ...sidesOf(own(b))].slice(0, 3),
        edit: { ...draft, definition: draft.definition || null, relations: [...draft.relations, { verb, target: a.name }] },
      });
    }
  }

  const twoNames: DocQualityItem[] = similarPairs(glossary).map((p) => ({
    key: `tn:${p.a.key}|${p.b.key}`,
    type: "twonames",
    title: `“${p.a.name}” and “${p.b.name}” may be one thing`,
    hint: `${p.why}. If they are one thing, the glossary reads “${p.b.name}” as “${p.a.name}” everywhere.`,
    sides: [],
    pair: p,
  }));

  // Within a kind, the order of `entities`: the most described first.
  return [...onlyAdr, ...noDef, ...oneSided, ...twoNames];
}
