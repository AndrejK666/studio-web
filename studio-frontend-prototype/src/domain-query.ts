// Types for `POST /studio-domain-model/v1/query`, the experimental read over
// domain objects, built on the types generated from the model
// (`domain-model.gen.ts`, `scripts/gen-domain-client.mjs`).
//
// A field or a relation the model does not have fails here, at compile time,
// rather than as the query's 400. The call itself is `api.queryDomain`.

import type { DomainEntities, DomainEntity, DomainRelations } from "./domain-model.gen";

/** What a field the model types as `unknown` may be compared with. */
type Scalar = string | number | boolean;

/** The value an operator compares with: a list field compares its elements. */
type Operand<V> = unknown extends V ? Scalar : V extends readonly (infer I)[] ? I : V;

/**
 * Operators on one field, as the query takes them. A missing field matches no
 * comparison (SQL's reading); `_is_null: true` is how to ask for those.
 * `_contains` is a case-insensitive substring on text, membership on a list.
 */
export interface FieldOps<V> {
  _eq?: Operand<V>;
  _neq?: Operand<V>;
  _gt?: Operand<V>;
  _gte?: Operand<V>;
  _lt?: Operand<V>;
  _lte?: Operand<V>;
  _in?: Operand<V>[];
  _nin?: Operand<V>[];
  _contains?: Operand<V>;
  _is_null?: boolean;
}

/** A field of an entity, or `id`, the object's own id. */
export type DomainField<T extends DomainEntity> = (keyof DomainEntities[T] & string) | "id";

/** A boolean expression over an entity's fields. */
export type Where<T extends DomainEntity> = {
  [K in DomainField<T>]?: FieldOps<K extends keyof DomainEntities[T] ? NonNullable<DomainEntities[T][K]> : string>;
} & {
  _and?: Where<T>[];
  _or?: Where<T>[];
  _not?: Where<T>;
};

/** The entity a relation of `T` reaches. */
type Target<T extends DomainEntity, R extends keyof DomainRelations[T]> =
  DomainRelations[T][R] extends DomainEntity ? DomainRelations[T][R] : never;

/** What to read of one entity: the query's root, or one included relation. */
export interface DomainSelection<T extends DomainEntity> {
  where?: Where<T>;
  /** Rows without the field sort last; ties are broken by id. */
  order_by?: { field: DomainField<T>; direction?: "asc" | "desc" }[];
  /** The payload fields to return; omitted returns the whole payload. */
  fields?: DomainField<T>[];
  /** Relations to follow, by declared name, at most three levels deep. */
  include?: { [R in keyof DomainRelations[T]]?: DomainSelection<Target<T, R>> };
  /** 1..=200, default 50. Under `include` it is per parent row. */
  limit?: number;
}

export interface DomainQuery<T extends DomainEntity> extends DomainSelection<T> {
  type: T;
  /** The workspace/project scope objects were created in. Root type only. */
  scope?: string;
  offset?: number;
}

/** One object, with the relations that were included. */
export interface DomainRow<T extends DomainEntity> {
  id: string;
  /** The object's own entity: `T`, or an entity that extends it. */
  entity: string;
  value: DomainEntities[T];
  relations: { [R in keyof DomainRelations[T]]?: DomainRowSet<Target<T, R>> };
}

export interface DomainRowSet<T extends DomainEntity> {
  items: DomainRow<T>[];
  /** Matches before `limit`. */
  total: number;
  /** False when the read behind `total` stopped early. */
  complete: boolean;
}

export interface DomainQueryResult<T extends DomainEntity> extends DomainRowSet<T> {
  /** Where the answer may be wrong, e.g. two relations stored as one edge type. */
  warnings: string[];
}
