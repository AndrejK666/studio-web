// Constructor Studio: what the Product view offers with no product open.
//
// Gearbox Studio's Start screen is Home there: New and Open Product, the
// products in the workspace, and Recent. Studio does not open it at start-up,
// and on the desktop product-ext's own start page takes that place, so a member
// in Building never saw Recent at all. The Product view is what Building shows
// in the centre, so its empty state carries the same three things. The Start
// screen stays reachable from View > Views; this is not a second copy of it but
// the part of it a member needs to get to a product.

import React from "@theia/core/shared/react";

import type { ProductRef } from "../../common/protocol";

/** A remembered product, as `ProductSessionService.recentEntries` keeps it. */
export interface RecentProduct extends ProductRef {
  readonly openedAt?: number;
}

export interface EmptyStateLists {
  /** Discovered in the workspace, in discovery's order. */
  readonly workspace: readonly ProductRef[];
  /** Remembered, most recent first, minus any the workspace list already shows. */
  readonly recent: readonly RecentProduct[];
  /** The most recently opened product, whichever list it is in; the Continue button. */
  readonly last: RecentProduct | undefined;
}

/**
 * The lists the empty state draws.
 *
 * **A product shows once.** One discovered in the workspace and also opened
 * before is listed under the workspace -- that entry is current, the Recent one
 * is a memory -- and Recent keeps only the ones discovery did not find: another
 * checkout, a product outside the opened folder. Paths are compared with their
 * separators and case normalised, because on Windows the same file is reported
 * as `C:\a\product.gdl` by one side and `c:/a/product.gdl` by the other.
 */
export function emptyStateLists(
  found: readonly ProductRef[],
  remembered: readonly RecentProduct[],
): EmptyStateLists {
  const key = (path: string): string => {
    const slashed = path.replace(/\\/g, "/");
    return /^[a-zA-Z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
  };
  const seen = new Set(found.map((ref) => key(ref.path)));
  return {
    workspace: found,
    recent: remembered.filter((ref) => !seen.has(key(ref.path))),
    last: remembered[0],
  };
}

export interface ProductEmptyStateProps {
  readonly lists: EmptyStateLists;
  readonly engineConnected: boolean;
  readonly onNew: () => void;
  readonly onOpen: () => void;
  readonly onOpenWorkspace: (ref: ProductRef) => void;
  readonly onOpenRecent: (ref: ProductRef) => void;
}

export function ProductEmptyState(props: ProductEmptyStateProps): React.ReactElement {
  const { lists, engineConnected } = props;
  const nothing = lists.workspace.length === 0 && lists.recent.length === 0;
  return (
    <div className="gbx-empty gbx-product-empty" data-product-empty>
      {nothing && (
        <>
          <p>
            This workspace has no product yet: no <code>product.gdl</code> at{" "}
            <code>product.gdl</code> or <code>products/&lt;name&gt;/product.gdl</code>, in the
            opened folder or in any checkout directly under it. The gears in it are in the
            catalogue either way.
          </p>
          <p>Create one from gears, or open a product description to resolve it.</p>
        </>
      )}
      <div className="gbx-product-actions">
        {lists.last !== undefined && (
          <button
            type="button"
            className="gbx-start-primary gbx-start-continue"
            data-product-empty-action="continue"
            data-continue={lists.last.path}
            disabled={!engineConnected}
            onClick={() => lists.last !== undefined && props.onOpenRecent(lists.last)}
          >
            Continue {lists.last.label}
          </button>
        )}
        <button
          type="button"
          className="gbx-start-primary"
          data-product-empty-action="new"
          disabled={!engineConnected}
          title={engineConnected ? undefined : "The Gearbox engine is not running"}
          onClick={props.onNew}
        >
          New Product…
        </button>
        <button
          type="button"
          className="gbx-start-primary gbx-start-secondary"
          data-product-empty-action="open"
          onClick={props.onOpen}
        >
          Open Product…
        </button>
      </div>
      <ProductList
        label="In this workspace"
        kind="workspace"
        refs={lists.workspace}
        onPick={props.onOpenWorkspace}
      />
      <ProductList label="Recent" kind="recent" refs={lists.recent} onPick={props.onOpenRecent} />
    </div>
  );
}

function ProductList(props: {
  readonly label: string;
  readonly kind: string;
  readonly refs: readonly ProductRef[];
  readonly onPick: (ref: ProductRef) => void;
}): React.ReactElement | null {
  if (props.refs.length === 0) return null;
  return (
    <div className="gbx-start-section" data-product-empty-list={props.kind}>
      <div className="gbx-start-label">{props.label}</div>
      <ul className="gbx-start-items">
        {props.refs.map((ref) => (
          <li key={ref.path}>
            <button
              type="button"
              className="gbx-start-item"
              data-product-empty-product={ref.path}
              onClick={() => props.onPick({ path: ref.path, label: ref.label })}
            >
              <span className="gbx-start-item-name">{ref.label}</span>
              <span className="gbx-start-item-path">{ref.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
