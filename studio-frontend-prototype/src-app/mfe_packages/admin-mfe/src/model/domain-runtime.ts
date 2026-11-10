// The pure part of the prototype's src/domain-runtime.ts (studio-frontend-poc/), unchanged but for `meta.kit` and
// `meta.kit_version` (ADR-0067 §6, issue #1025). Left out: the build's seed (domain-model.gen.ts), the helpers only
// other screens use (`openFieldsOf`), and the module-level loader and hooks, which the Studio
// domain model section replaces with its own read of `GET /studio-domain-model/v1/types` (`modelOf` below is that
// loader's `build`).
//
// The domain model as the server holds it now, not as it was when the portal
// was built. The walk over `extends` and the field kinds are the generator's
// (`scripts/gen-domain-client.mjs`), so a field reads the same either way.

/** A field's kind, as `domain-model.gen.ts` declares it. */
export type DomainFieldKind =
  | { kind: "string" | "number" | "boolean" | "list" | "unknown" }
  | { kind: "enum"; values: readonly string[] };

/** One property of an entity as the model document has it. */
export interface ModelProperty {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  extends?: string;
  relationType?: string;
  relationLabel?: string;
  /** The gear that writes this field (ADR-0066 §8a): not to be renamed,
   *  retyped or dropped, nor set from a screen. */
  held_by?: string;
}

/** One entity as the model document has it. */
export interface ModelEntity {
  id: string;
  name?: string;
  description?: string;
  bucket?: string;
  extends?: string | null;
  abstract?: boolean;
  properties?: ModelProperty[];
  /** `held_by`: the gear whose records this type's objects are; `origin`
   *  (`upload`, `organization`, `studio`, `kit`) and `upload`: where it came
   *  from; `kit` and `kit_version`: the kit that brought it (ADR-0067 §6). */
  meta?: { declared_by?: string; held_by?: string; origin?: string; upload?: string; kit?: string; kit_version?: string } | null;
}

/** A payload field of an entity, own or inherited, with what a screen needs to edit it. */
export interface ModelField {
  name: string;
  /** The declared type expression (`string`, `planned | active`, `timestamp?`). */
  type: string;
  kind: DomainFieldKind;
  required: boolean;
  description: string;
  /** The entity that declares it: this one, or a base. */
  declaredBy: string;
  /** The gear that writes it, when one does. */
  heldBy?: string;
}

export interface DomainModel {
  entities: ModelEntity[];
  byId: Map<string, ModelEntity>;
  buckets: { id: string; name: string }[];
  /** Whether the caller may change the model (`domain.model`, ADR-0035). */
  canEdit: boolean;
  /** Studio's own types: what every organization starts with. */
  studioTypes: Set<string>;
  /** Where it came from: the server, or the build's seed while that loads. */
  source: "server" | "seed";
  /** The GTS ids the server registers each type and relation kind under;
   *  empty for the seed. */
  gts: GtsCatalog;
}

/** One GTS id: ours, and the one graph-storage keeps with its family. */
export interface GtsId {
  type: string;
  stored_as: string;
}

export interface GtsCatalog {
  types: Record<string, GtsId>;
  relations: Record<string, GtsId>;
}

const isRelation = (p: ModelProperty) => p.extends === "edge" || p.extends === "link";

/** A type expression's kind: the generator's `fieldKind`, at runtime. */
export function kindOf(expr: string | undefined): DomainFieldKind {
  let t = String(expr ?? "").trim().replace(/\?$/, "").trim();
  if (t.endsWith("[]")) return { kind: "list" };
  if (t.includes("|")) {
    const parts = t.split("|").map((s) => s.trim());
    if (parts.every((s) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s) && /^[a-z]/.test(s))) {
      return { kind: "enum", values: parts };
    }
    return { kind: "unknown" };
  }
  t = t.toLowerCase();
  if (/^(string|text|url|uri|hash|sha|textcontent|email)$/.test(t)) return { kind: "string" };
  if (/^timestamp|date-?time|date$/.test(t)) return { kind: "string" };
  if (/^(integer|int|number|decimal|float)$/.test(t) || /^\d+\.\.\d+$/.test(t)) return { kind: "number" };
  if (/^bool(ean)?$/.test(t)) return { kind: "boolean" };
  if (/(id|ref)$/.test(t)) return { kind: "string" };
  return { kind: "unknown" };
}

function build(
  entities: ModelEntity[],
  buckets: { id: string; name: string }[],
  canEdit: boolean,
  source: DomainModel["source"],
  studioTypes: string[] = [],
  gts: GtsCatalog = { types: {}, relations: {} },
): DomainModel {
  return { entities, byId: new Map(entities.map((e) => [e.id, e])), buckets, canEdit, source, studioTypes: new Set(studioTypes), gts };
}

/** What `GET /studio-domain-model/v1/types` answers, as the prototype's
 *  `reloadDomainModel` turned it into a model. */
export function modelOf(res: {
  ontology: { entities?: unknown[]; buckets?: unknown[] };
  can_edit_model: boolean;
  gts?: GtsCatalog;
}): DomainModel {
  const doc = res.ontology as { entities?: ModelEntity[]; buckets?: { id: string; name?: string }[] };
  return build(
    doc.entities ?? [],
    (doc.buckets ?? []).map((b) => ({ id: b.id, name: b.name ?? b.id })),
    res.can_edit_model,
    "server",
    (doc.entities ?? []).filter((e) => e.meta?.origin === "studio").map((e) => e.id),
    res.gts,
  );
}

/** The entity and every base it extends, nearest first; stops on a cycle. */
export function ancestorsOf(model: DomainModel, id: string): string[] {
  const chain = [id];
  for (let at = id; ; ) {
    const base = model.byId.get(at)?.extends;
    if (!base || !model.byId.has(base) || chain.includes(base)) return chain;
    chain.push(base);
    at = base;
  }
}

const normalize = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The entity a relation property points at, by its name or id. */
function targetOf(model: DomainModel, type: string | undefined): string | null {
  const t = normalize(type);
  if (!t) return null;
  return model.entities.find((e) => normalize(e.name) === t || normalize(e.id) === t)?.id ?? null;
}

/** The relations `include` follows from `id`, by name, and the entity each
 *  reaches (the prototype's `relationsOfModel`, carried for saved views). A
 *  name two bases point at different entities is left out: the query could
 *  not tell which one it means. */
export function relationsOfModel(model: DomainModel, id: string): Record<string, string> {
  const chain = new Set(ancestorsOf(model, id));
  const found: Record<string, string> = {};
  const ambiguous = new Set<string>();
  for (const e of model.entities) {
    if (!chain.has(e.id)) continue;
    for (const p of e.properties ?? []) {
      if (!isRelation(p) || !p.name) continue;
      const target = targetOf(model, p.type);
      if (!target) continue;
      if (p.name in found && found[p.name] !== target) ambiguous.add(p.name);
      else found[p.name] = target;
    }
  }
  for (const a of ambiguous) delete found[a];
  return found;
}

/** Own and inherited payload fields, root first, nearest declaration wins. */
export function fieldsOfModel(model: DomainModel, id: string): ModelField[] {
  const out: ModelField[] = [];
  for (const a of ancestorsOf(model, id).reverse()) {
    for (const p of model.byId.get(a)?.properties ?? []) {
      if (isRelation(p) || !p.name) continue;
      const field: ModelField = {
        name: p.name,
        type: p.type ?? "",
        kind: kindOf(p.type),
        required: !!p.required,
        description: p.description ?? "",
        declaredBy: a,
        heldBy: p.held_by,
      };
      const at = out.findIndex((x) => x.name === p.name);
      if (at >= 0) out[at] = field;
      else out.push(field);
    }
  }
  return out;
}
