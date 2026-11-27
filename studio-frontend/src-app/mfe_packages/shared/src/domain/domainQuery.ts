/**
 * `POST /studio-domain-model/v1/query` and `/mutate` as the generic screens
 * write them (ADR-0066): the request and answer shapes the gear documents
 * (`QueryObjectsRequest`, `QueryObjectsResponse`, `MutateObjectsRequest`), and
 * the few requests the screens build from the live model — pure, so they are
 * tested without a server.
 *
 * Each shape has a typed twin keyed by the type's name ({@link DomainQueryOf},
 * {@link DomainRowOf}, {@link DomainResultOf}): for a type `model.gen.ts`
 * knows, `fields`, `order_by` and `include` are checked against it and a row's
 * `value` has its fields; any other name (a kit's type) reads untyped, as the
 * plain shapes do.
 */

import type { DomainEntities, DomainEntity, DomainRelations } from './model.gen';
import { fieldsOfModel, type DomainModel, type ModelField } from './runtime';

export type SortDirection = 'asc' | 'desc';

export interface DomainOrderBy {
  field: string;
  direction?: SortDirection;
}

/** What to read of one type, or of one relation of it under `include`. */
export interface DomainSelection {
  /**
   * Hasura-style: `{status: {_eq: 'active'}}`, `_and` / `_or` / `_not`. A
   * declared relation in place of a field filters by the objects one hop
   * away (`{delivers: {status: {_eq: 'active'}}}`, backwards with `~`); on
   * the root only. `{_type: {_in: ['deals-project']}}` tests the object's
   * concrete type (the row's `entity`): the queried type or one extending it.
   */
  where?: Record<string, unknown>;
  order_by?: DomainOrderBy[];
  fields?: string[];
  include?: Record<string, DomainSelection>;
  /** 1..=200, default 50; per parent under `include`. */
  limit?: number;
}

export interface DomainQueryRequest extends DomainSelection {
  /**
   * An ontology id (`project`), a node type id or its leaf. The answer holds
   * the objects of every type extending it too, each row naming its own.
   */
  type: string;
  /** The workspace or project the objects were created in (its tenant id). */
  project_id?: string;
  /**
   * Several projects at once (at most 200), not with `project_id`. One the
   * caller may not read refuses the whole request (403).
   */
  project_ids?: string[];
  offset?: number;
  /** The previous page's `next_cursor`: the rows after it (keyset paging). */
  cursor?: string;
  /** Counts of the matches grouped by fields, answered as `groups`. */
  aggregate?: DomainAggregate;
}

/** The span a grouped timestamp is cut to: the day, ISO week (from Monday) or month it falls in (UTC). */
export type DomainBucket = 'day' | 'week' | 'month';

/**
 * Counts per group of up to three keys (none: every match is one group), with
 * folds per group: `sum` / `avg` of numeric fields, `min` / `max` of numeric
 * or timestamp fields. A field of another type is a 400.
 */
export interface DomainAggregate {
  group_by: string[];
  /** Grouped timestamp fields cut to a bucket: `{created_at: 'month'}`. */
  bucket?: Record<string, DomainBucket>;
  sum?: string[];
  avg?: string[];
  min?: string[];
  max?: string[];
}

/**
 * One group of an aggregate. A bucketed key is the bucket's first day,
 * `YYYY-MM-DD`, or `null` where the value is not a timestamp. Each fold maps
 * its fields to the group's value (`null` where no row holds one).
 */
export interface DomainGroup {
  key: unknown[];
  count: number;
  sum?: Record<string, number | null>;
  avg?: Record<string, number | null>;
  min?: Record<string, number | string | null>;
  max?: Record<string, number | string | null>;
}

/** One object of an answer: `{id, entity, value, relations}`. */
export interface DomainQueryRow {
  id: string;
  entity: string;
  value: Record<string, unknown>;
  relations?: Record<string, DomainRowSet>;
}

export interface DomainRowSet {
  items: DomainQueryRow[];
  /** Matches across every page. */
  total: number;
  /** False when the graph answered and stopped at its read limit. */
  complete: boolean;
}

export interface DomainQueryResult extends DomainRowSet {
  warnings?: string[];
  /** `read_model` (Postgres) or `graph`. */
  source?: string;
  next_cursor?: string | null;
  /** With `aggregate`: the matches counted (and folded) per group. */
  groups?: DomainGroup[] | null;
}

// ── Typed by the generated model ──────────────────────────────────────────

/**
 * A row's `value` for type `T`: its generated interface where `model.gen.ts`
 * has the type (still indexable, since a subtype's row carries more fields),
 * a free record otherwise.
 */
export type DomainValueOf<T extends string> = [T] extends [DomainEntity]
  ? DomainEntities[T] & Record<string, unknown>
  : Record<string, unknown>;

/** The fields `fields` and `order_by` may name on `T`: its own and `id`; any string for a type the generated model does not have. */
export type DomainFieldOf<T extends string> = [T] extends [DomainEntity]
  ? (keyof DomainEntities[T] & string) | 'id' | `${keyof DomainEntities[T] & string}.${string}`
  : string;

/** A relation named backwards (`~delivers`) or qualified (`team.delivers`): not checked here, the gear checks it. */
type LooseRelation = `~${string}` | `${string}.${string}`;

/** `include` on `T`: each relation the generated model declares, with its target's selection. */
export type DomainIncludeOf<T extends string> = [T] extends [DomainEntity]
  ? {
      [R in keyof DomainRelations[T] & string]?: DomainSelectionOf<DomainRelations[T][R] & string>;
    } & { [loose: LooseRelation]: DomainSelection }
  : Record<string, DomainSelection>;

export interface DomainOrderByOf<T extends string> {
  field: DomainFieldOf<T>;
  direction?: SortDirection;
}

/** {@link DomainSelection} checked against type `T`. */
export interface DomainSelectionOf<T extends string> {
  where?: Record<string, unknown>;
  order_by?: DomainOrderByOf<T>[];
  fields?: DomainFieldOf<T>[];
  include?: DomainIncludeOf<T>;
  limit?: number;
}

/** {@link DomainQueryRequest} for type `T`. */
export interface DomainQueryOf<T extends string> extends DomainSelectionOf<T> {
  type: T;
  project_id?: string;
  project_ids?: string[];
  offset?: number;
  cursor?: string;
  aggregate?: DomainAggregate;
}

/** {@link DomainQueryRow} of type `T`. */
export interface DomainRowOf<T extends string> extends Omit<DomainQueryRow, 'value'> {
  value: DomainValueOf<T>;
}

/** {@link DomainQueryResult} of type `T`. */
export interface DomainResultOf<T extends string> extends Omit<DomainQueryResult, 'items'> {
  items: DomainRowOf<T>[];
}

export type DomainOperation =
  | { op: 'patch'; id: string; set?: Record<string, unknown>; unset?: string[] }
  | { op: 'delete'; id: string }
  | {
      op: 'upsert';
      type: string;
      key: string;
      value: Record<string, unknown>;
      project_id?: string;
    };

export interface DomainMutation {
  operations: DomainOperation[];
  validate?: 'strict' | 'warn' | 'off';
}

export interface DomainMutationResult {
  results: { op: string; id: string; violations?: unknown[] }[];
}

/** The gear's page ceiling. */
export const QUERY_MAX_LIMIT = 200;
/** A generic tab's page. */
export const LIST_PAGE = 50;

export interface SortState {
  field: string;
  direction: SortDirection;
}

/** A column header clicked: ascending, then descending, then the gear's own order. */
export function nextSort(current: SortState | null, field: string): SortState | null {
  if (!current || current.field !== field) return { field, direction: 'asc' };
  if (current.direction === 'asc') return { field, direction: 'desc' };
  return null;
}

/** The objects of `type` in a level: the workspace or project scope they were
 *  created in, or the whole organization when `scope` is null. */
export function listQuery({
  type,
  scope,
  sort,
  limit = LIST_PAGE,
  offset = 0,
}: {
  type: string;
  scope: string | null;
  sort?: SortState | null;
  limit?: number;
  offset?: number;
}): DomainQueryRequest {
  const q: DomainQueryRequest = { type, limit: Math.min(Math.max(1, limit), QUERY_MAX_LIMIT) };
  if (scope) q.project_id = scope;
  if (sort) q.order_by = [{ field: sort.field, direction: sort.direction }];
  if (offset > 0) q.offset = offset;
  return q;
}

/** One object by its id, with one relation followed when `relation` is named. */
export function objectQuery({
  type,
  id,
  relation,
  limit = 20,
}: {
  type: string;
  id: string;
  relation?: string;
  limit?: number;
}): DomainQueryRequest {
  const q: DomainQueryRequest = { type, where: { id: { _eq: id } }, limit: 1 };
  if (relation) q.include = { [relation]: { limit: Math.min(Math.max(1, limit), QUERY_MAX_LIMIT) } };
  return q;
}

/**
 * The object that describes a tenant (an organization, a workspace, a
 * project): the type's object keyed `self` in the tenant's own scope, found by
 * the tenant's id in `tenant_id`, a field every model type inherits — as the
 * prototype's `ObjectAttributes` read and wrote it.
 */
export function selfQuery(type: string, tenantId: string): DomainQueryRequest {
  return { type, project_id: tenantId, where: { tenant_id: { _eq: tenantId } }, limit: 1 };
}

/** The key of the object that describes a tenant. */
export const SELF_KEY = 'self';

/** The model's primitives: fields every object has for the store, not for people. */
export const SYSTEM_BUCKET = 'system-primitives';

/** The fields of `type` a person reads: every own and inherited one but the
 *  model's system fields and the id. */
export function readableFields(model: DomainModel, type: string): ModelField[] {
  if (!model.byId.has(type)) return [];
  const system = new Set(model.entities.filter((e) => e.bucket === SYSTEM_BUCKET).map((e) => e.id));
  return fieldsOfModel(model, type).filter((f) => !system.has(f.declaredBy) && f.name !== 'id');
}

const NAMING = ['name', 'title'];

/** A generic table's columns: the naming fields first, then what the type
 *  itself declares, then what its bases do; fields of no kind a cell can show
 *  are left out, and at most `max`. */
export function tableColumns(model: DomainModel, type: string, max = 6): ModelField[] {
  const fields = readableFields(model, type).filter((f) => f.kind.kind !== 'unknown');
  const rank = (f: ModelField) => (NAMING.includes(f.name) ? 0 : f.declaredBy === type ? 1 : 2);
  return fields
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map(({ f }) => f)
    .slice(0, max);
}

/** What a person filled in, as the value each field's kind stores; null clears it. */
export function parsedValue(field: ModelField, raw: string | boolean): unknown {
  if (typeof raw === 'boolean') return raw;
  const v = raw.trim();
  if (v === '') return null;
  switch (field.kind.kind) {
    case 'number':
      return Number.isNaN(Number(v)) ? v : Number(v);
    case 'list':
      return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    case 'unknown':
      try {
        return JSON.parse(v) as unknown;
      } catch {
        return v;
      }
    default:
      return v;
  }
}

/** A stored value as an input holds it. */
export function inputValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * The one write that saves an Attributes card: a patch of the object when it
 * exists, else an upsert of the tenant's `self` object carrying `tenant_id`
 * and the facts the tenant already says about itself (its name). Null when
 * nothing changed.
 */
export function attributesWrite({
  type,
  tenantId,
  objectId,
  fields,
  before,
  draft,
  facts = {},
}: {
  type: string;
  tenantId: string;
  objectId: string | null;
  fields: readonly ModelField[];
  before: Record<string, unknown>;
  draft: Record<string, string | boolean>;
  facts?: Record<string, unknown>;
}): DomainOperation | null {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const f of fields) {
    if (!(f.name in draft) || f.heldBy) continue;
    const next = parsedValue(f, draft[f.name] ?? '');
    const prior = before[f.name] ?? null;
    if (JSON.stringify(next) === JSON.stringify(prior)) continue;
    if (next === null) unset.push(f.name);
    else set[f.name] = next;
  }
  if (objectId) {
    if (Object.keys(set).length === 0 && unset.length === 0) return null;
    return { op: 'patch', id: objectId, set, unset };
  }
  const value: Record<string, unknown> = { ...facts, ...set, tenant_id: tenantId };
  return { op: 'upsert', type, key: SELF_KEY, project_id: tenantId, value };
}

/** An RFC 3339 instant as the server stores one (`2026-11-19T07:08:10.16Z`). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** A stored value as text, for reading: an instant in the reader's own
 *  date and time, not the wire format. */
export function shownValue(v: unknown, yes = 'yes', no = 'no', locale?: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.map((x) => shownValue(x, yes, no, locale)).join(', ');
  if (typeof v === 'boolean') return v ? yes : no;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && INSTANT.test(v)) {
    const at = new Date(v);
    if (!Number.isNaN(at.getTime())) return at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  }
  return String(v);
}
