// Constructor Studio: `ScreenScopeService`, started, inside the Gearbox
// perspective only, and only for what goes stale.
//
// Gearbox Studio reconciled its whole shell with the context: it withdrew the
// screens of a product that was no longer open, folded all three side panels on
// Home, and put the context's own screen (Start, Product, Gear) in front. Bound
// but never started here, the first of those went missing too: after product B
// opened, product A's Add Gear, Lock and Generate stayed on screen, drawn from a
// product that was gone (the write boundary, `ownsSubject`, refused a commit
// through them, but the panels were stale).
//
// This starts it, contained three ways:
//
//  * **Gated by `gearboxOwnsLayout`.** A pass runs only while a Gearbox
//    perspective is the active one. Outside it Studio's layout is Studio's, and
//    nothing here closes a view -- not even a Gearbox one in FULL SUPER POWER.
//    A pass skipped that way is not recorded as done, so the next change of
//    perspective into Building reconciles then.
//  * **It withdraws, and does nothing else.** No panel preset: folding the
//    catalogue, Inspector and Conflicts on Home is Gearbox Studio's Home, and
//    Building's layout is Studio's perspective. No Start screen on Home: on the
//    desktop product-ext's start page stands where Start stood, and the Product
//    view's empty state is where Building offers the way to a product.
//  * **The perspective's frame stays.** The Product view and Conflicts are the
//    Gearbox perspective's centre and bottom; with no product the Product view is
//    the empty state (New, Open, Recent), so closing it on Home would take away
//    the way back to a product. They re-render from the store when the product
//    changes and hold nothing of the previous one.
//
// `FocusModeService` is left as it was: it folds panels for a focus screen, and
// is already gated by the same predicate.

import { PerspectiveService } from "@theia/core/lib/browser/perspective-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import type { Widget } from "@theia/core/shared/@lumino/widgets";

import { gearboxOwnsLayout } from "./gearbox-shell-gate";
import type { PanelArea } from "./focus-mode-service";
import { ScreenScopeService } from "./screen-scope-service";
import { outOfScope, type ContextIdentity, type ContextKind } from "./screens";
import type { StudioContext } from "./studio-context-service";

/**
 * The Gearbox perspective's own frame: kept whatever the context, because the
 * perspective lays them out and each renders the current product or none.
 */
export const PERSPECTIVE_FRAME: readonly string[] = ["gearbox.product", "gearbox.conflicts"];

/** Whether Studio may withdraw this widget when the subject moves. */
export function studioMayWithdraw(widgetId: string): boolean {
  return !PERSPECTIVE_FRAME.includes(widgetId);
}

@injectable()
export class StudioScreenScopeService extends ScreenScopeService {
  @inject(PerspectiveService) protected readonly perspectives!: PerspectiveService;

  override onStart(): void {
    super.onStart();
    // A pass skipped outside the Gearbox perspective is owed on the way in.
    this.perspectives.onDidChangePerspective(() => this.enqueue());
  }

  protected override async reconcile(): Promise<void> {
    if (!gearboxOwnsLayout(this.perspectives)) return;
    await super.reconcile();
  }

  /**
   * The base class's withdrawal, restated with the frame left out: the same
   * two reasons a screen goes (its kind of context ended, or the subject it was
   * opened under moved), and the same rule that a recorded owner can save a
   * screen but never condemn one.
   */
  protected override async withdraw(to: ContextIdentity): Promise<void> {
    const declared = new Set(outOfScope(this.applied, to));
    const doomed: Widget[] = [];
    for (const widget of this.shell.widgets) {
      if (!widget.isAttached || !studioMayWithdraw(widget.id)) continue;
      const owner = this.ownerOf(widget);
      if (owner === to) continue;
      if (declared.has(widget.id) || owner !== undefined) doomed.push(widget);
    }
    if (doomed.length === 0) return;
    await this.shell.closeMany(doomed);
  }

  protected override applyPreset(_kind: ContextKind): readonly PanelArea[] {
    return [];
  }

  protected override async reassertPrimary(context: StudioContext): Promise<void> {
    if (context.kind === "home") return;
    await super.reassertPrimary(context);
  }
}
