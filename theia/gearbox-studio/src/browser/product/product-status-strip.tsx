// Constructor Studio: the product's state and its draft, on one strip at the
// top of the Product view.
//
// Gearbox Studio drew this in its shell header (`ToolbarWidget`): the product's
// resolved state, the `modified` badge with **Apply changes / Discard**, and
// Close / Resolve. Studio's top panel is its own -- the menu, the mode tabs and
// the ribbon -- and a second header there would be the shell subtraction this
// port does not do. So the header's product half lives here, in the Product
// view's head, which stays on screen on every stage and is where the pending
// edits are made. The header was the only caller of `applyDraft` and
// `discardDraft`; without it a draft could be queued and never written.
//
// What is left out of the header, and why: the product's name and its profile
// are already the first two lines of the same head (the title and the profile
// switch), and Generate is the strip's `Generate →` tab. The gear context's half
// has no Studio surface yet.
//
// The deciding is in plain functions (`productStatusOf`, `draftStateOf`) so it
// is tested without a widget; the component only draws what they say.

import React from "@theia/core/shared/react";

import type { ProductStatus } from "../product-store";

/** What the strip says about the resolution, or nothing when there is nothing to say. */
export type ProductStatusBadge =
  | { readonly kind: "working" }
  | { readonly kind: "conflicts"; readonly count: number }
  | { readonly kind: "resolved" }
  | undefined;

/**
 * Resolving, the count of errors, or resolved -- the header's `renderStatus`.
 *
 * Errors are counted, not listed: the list is the Conflicts screen, and the
 * count opens it. `errors` is from the store's `diagnostics`, not the
 * resolution's: a refused load leaves the diagnostics and no resolution, and
 * counting through the resolution said nothing exactly when there was something
 * to say.
 */
export function productStatusOf(status: ProductStatus, errors: number, resolved: boolean): ProductStatusBadge {
  if (status === "loading" || status === "resolving") return { kind: "working" };
  if (errors > 0) return { kind: "conflicts", count: errors };
  if (resolved) return { kind: "resolved" };
  return undefined;
}

/** What the draft half of the strip offers. */
export type DraftState =
  | { readonly kind: "saved" }
  | { readonly kind: "pending"; readonly count: number; readonly applyRefusal: string | undefined }
  | { readonly kind: "unverified"; readonly count: number };

/**
 * Whether there is a draft, and whether Apply can write it now.
 *
 * **After a write of unknown fate the draft is not "pending".** The engine may
 * have saved exactly these edits without saying so, so the strip says the state
 * is unknown and offers Discard only: applying again before the description is
 * re-read would be deciding on a file nobody has looked at.
 *
 * **Apply needs the engine**: it is a dry run, a confirmation and a write. With
 * the engine gone the button stays, disabled, and says why -- a draft that
 * cannot be applied now is still a draft, and Discard still works.
 */
export function draftStateOf(args: {
  readonly count: number;
  readonly writeUnknown: boolean;
  readonly engineConnected: boolean;
  readonly busy: boolean;
}): DraftState {
  if (args.count === 0) return { kind: "saved" };
  if (args.writeUnknown) return { kind: "unverified", count: args.count };
  const applyRefusal = !args.engineConnected
    ? "The Gearbox engine is not running; reconnect first"
    : args.busy
      ? "The product is being read; wait for it"
      : undefined;
  return { kind: "pending", count: args.count, applyRefusal };
}

/** One command button on the strip, as the registry describes it. */
export interface StripAction {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly enabled: boolean;
}

export interface ProductStatusStripProps {
  readonly status: ProductStatusBadge;
  readonly draft: DraftState;
  readonly actions: readonly StripAction[];
  readonly onApply: () => void;
  readonly onDiscard: () => void;
  readonly onShowConflicts: () => void;
  readonly onRun: (id: string) => void;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function ProductStatusStrip(props: ProductStatusStripProps): React.ReactElement {
  const { status, draft } = props;
  return (
    <div className="gbx-product-status" data-product-status-strip>
      <div className="gbx-product-status-state" aria-live="polite">
        {status?.kind === "working" && (
          <span className="gbx-product-status-badge" data-status="working">
            resolving…
          </span>
        )}
        {status?.kind === "conflicts" && (
          // A button, not a label: the count is useful only if it leads to where
          // each one can be read and acted on.
          <button
            type="button"
            className="gbx-badge gbx-downgraded gbx-product-status-badge"
            data-status="conflicts"
            data-conflicts={status.count}
            title="Show the conflicts"
            onClick={props.onShowConflicts}
          >
            {plural(status.count, "conflict", "conflicts")}
          </button>
        )}
        {status?.kind === "resolved" && (
          <span className="gbx-badge gbx-product-status-badge" data-status="resolved">
            resolved
          </span>
        )}

        {draft.kind === "saved" && (
          <span className="gbx-product-status-draft" data-draft-state="saved">
            Saved
          </span>
        )}
        {draft.kind === "unverified" && (
          <span className="gbx-product-status-draft" data-draft-state="unverified" data-draft-unverified>
            {plural(draft.count, "change", "changes")} of unknown state — the last write was never
            confirmed. Reconnect to re-read the description.
          </span>
        )}
        {draft.kind === "pending" && (
          <span className="gbx-badge gbx-product-status-draft" data-draft-state="pending" data-status="modified" title="Unapplied draft edits">
            {plural(draft.count, "pending change", "pending changes")}
          </span>
        )}
        {/* **One pair, here, because there is one draft.** A draft commits as one
            dry run, one confirmation and one write, whichever panel queued its
            edits, so the pair sits beside the count and not in each panel. */}
        {draft.kind === "pending" && (
          <button
            type="button"
            className="gbx-choice gbx-product-status-apply"
            data-draft-apply
            disabled={draft.applyRefusal !== undefined}
            title={draft.applyRefusal ?? "Apply the draft edits to the description"}
            onClick={props.onApply}
          >
            Apply changes
          </button>
        )}
        {draft.kind !== "saved" && (
          <button
            type="button"
            className="gbx-choice"
            data-draft-discard
            title="Drop the draft edits and restore the saved values"
            onClick={props.onDiscard}
          >
            Discard
          </button>
        )}
      </div>
      <div className="gbx-product-status-actions">
        {props.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="gbx-choice"
            data-command={action.id}
            disabled={!action.enabled}
            title={action.title}
            onClick={() => props.onRun(action.id)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
