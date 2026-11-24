/**
 * Which types the Studio domain model has installed for the organization in
 * scope (ADR-0070 §2, §4), for the shell: a screen that shows another kit's
 * type declares it (`presentation.needs`) and shows only where the type is
 * installed. `GET /types` without `include=dormant` already leaves out what a
 * kit left dormant. Read through mfe-shared's `useDomainTypes`, the one cached
 * read of the model every reader shares.
 */

/** The part of `GET /studio-domain-model/v1/types` the shell reads. */
export interface ModelTypesSummary {
  ontology: { entities?: { id?: string; meta?: { gts?: unknown } | null }[] };
}
