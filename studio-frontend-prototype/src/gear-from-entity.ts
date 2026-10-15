// A Domain entity no gear keeps, turned into the request for a gear that
// will: its name, what it is for, what it stores and how it relates. The
// Domain model's "Create a gear for it" hands this to the Product tab, whose
// scaffold dialog opens with it filled in.
//
// The name is chosen so the gear, once its repository declares it, is matched
// back to the entity by entity-gears.ts: a gear named after a thing keeps it.
// A plural reads better (`invoice-lines`), but only when the model's own
// folding turns it back into the entity's key -- "entries" does not fold to
// "entry", so that one stays singular.
//
// Pure: domain-model-screens.tsx drafts it, kits.tsx sends it.

import { definitionFrom } from "./doc-quality";
import { entityDraft } from "./domain-layers";
import { gearSubjects } from "./entity-gears";
import { gearSlug } from "./scaffold";
import type { Entity } from "./spec-model";

/** What the new gear is asked to be, drafted from one entity. */
export interface GearDraft {
  /** The entity it is for, by key, and as the documents name it. */
  entityKey: string;
  entityName: string;
  /** The gear's name as the scaffold takes it: kebab-case, `cf-gears-` is added by the server. */
  name: string;
  /** One sentence: what the entity is. */
  description: string;
  /** What it stores: the entity's attributes. */
  fields: { name: string; meaning: string }[];
  /** How it relates to other entities. */
  relations: { verb: string; target: string }[];
  /** Where the request came from, for the gear's manifest. */
  origin: string;
}

/** How many fields and relations the request spells out: the PRD is a start, not the model. */
const MAX_FIELDS = 8;
const MAX_RELATIONS = 5;

/** `line` → `lines`, `address` → `addresses`, `policy` → `policies`. */
function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Whether a gear of this name would be found as the entity's keeper. Both
 *  spellings are tried: a project's plan may list the gear by its own name or
 *  by its crate. */
export function nameKeeps(entityKey: string, name: string): boolean {
  const slug = gearSlug(name);
  return [slug, `cf-gears-${slug}`].every((n) => gearSubjects(n).includes(entityKey));
}

/** The gear's name for an entity: its words in kebab-case, the last one
 *  plural when that still folds back to the entity. */
export function gearNameFor(e: Pick<Entity, "key" | "name">): string {
  const singular = gearSlug(e.key || e.name);
  const words = singular.split("-");
  const pluralName = [...words.slice(0, -1), plural(words[words.length - 1])].join("-");
  if (nameKeeps(e.key, pluralName)) return pluralName;
  return singular;
}

/** Why a typed-in name would lose the entity, or null when it keeps it. */
export function nameWarning(entityKey: string, entityName: string, name: string): string | null {
  if (!name.trim()) return "A gear needs a name.";
  return nameKeeps(entityKey, name)
    ? null
    : `The Domain model will not see this gear as keeping “${entityName}”: its name has to be the entity's (e.g. ${gearNameFor({ key: entityKey, name: entityName })}).`;
}

/** The request for a gear that keeps this entity. */
export function gearDraftFrom(e: Pick<Entity, "key" | "name" | "facts">): GearDraft {
  const draft = entityDraft(e);
  // The documents' own definition when they give one; else the sentence the
  // documentation-quality check would propose; never the placeholder.
  let description = draft.definition.trim() || definitionFrom(e);
  if (/ is …$/.test(description)) description = `Keeps the product's ${e.name} records.`;
  return {
    entityKey: e.key,
    entityName: e.name,
    name: gearNameFor(e),
    description,
    fields: draft.fields.slice(0, MAX_FIELDS),
    relations: draft.relations.slice(0, MAX_RELATIONS),
    origin: `Drafted from the Domain model entity “${e.name}”, which no gear kept.`,
  };
}

/** "a, b and c". */
function listed(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The PRD's problem as the scaffold takes it. The scaffold has no field for
 *  stored data or relations, so they are said in words: the session agent that
 *  fills the skeleton reads them there. */
export function gearProblemFrom(d: Pick<GearDraft, "entityName" | "description" | "fields" | "relations">): string {
  const parts = [d.description.trim()];
  if (d.fields.length) parts.push(`It stores each ${d.entityName}'s ${listed(d.fields.map((f) => f.name))}.`);
  if (d.relations.length) parts.push(`${/^[aeiou]/i.test(d.entityName) ? "An" : "A"} ${d.entityName} ${listed(d.relations.map((r) => `${r.verb} ${r.target}`))}.`);
  return parts.filter(Boolean).join(" ");
}
