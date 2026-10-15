/**
 * The gear repositories a remote catalogue is read from (ADR-0046): the corpus
 * the Studio backend lists is one or more repositories, each brought here
 * under its source id. A backend from before ADR-0046 phase 2 names one.
 */

import type { CorpusOrigin, RemoteCatalogue } from "../common/protocol";

/** Every gear repository a remote catalogue names, in order: its `origins`,
 *  else its one `origin`. */
export function originsOf(remote: RemoteCatalogue): readonly CorpusOrigin[] {
  if (remote.origins !== undefined && remote.origins.length > 0) return remote.origins;
  return remote.origin === undefined ? [] : [remote.origin];
}

/** Why the listed corpus cannot be brought here, or `undefined` when it can:
 *  each repository must be public, or relayed by the Studio backend. */
export function unbringable(origins: readonly CorpusOrigin[]): string | undefined {
  const closed = origins.find((o) => o.needsToken && o.clonePath === undefined);
  if (closed === undefined) return undefined;
  return origins.length === 1
    ? "This corpus is private, and this Studio does not relay it."
    : `The gear repository ${closed.sourceId} is private, and this Studio does not relay it.`;
}
