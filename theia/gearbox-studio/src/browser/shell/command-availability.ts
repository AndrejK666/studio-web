// Constructor Studio: why a product command cannot run now, in words.
//
// Studio's ribbon (theia/studio, `ribbonAction`) draws a command that is not
// enabled as disabled, with a tooltip saying why when the handler can say: a
// handler may carry `disabledReason(...args)`. It is read by name, because the
// two extensions share no import. Theia's own surfaces ignore it.

import type { CommandHandler } from "@theia/core/lib/common/command";

export const NO_PRODUCT = "Open or create a product first";
export const STILL_OPENING = "The product is still opening";
export const ENGINE_DOWN = "The Gearbox engine is not running";

/** A command handler that can say why it is disabled. */
export interface ExplainedHandler extends CommandHandler {
  disabledReason(...args: unknown[]): string | undefined;
}

/** `handler`, typed so the extra method passes `registerCommand`'s check. */
export function explained(handler: ExplainedHandler): CommandHandler {
  return handler;
}

export interface ProductCommandState {
  readonly productOpen: boolean;
  /** A product is being opened and is not open yet. */
  readonly opening: boolean;
  readonly engineConnected: boolean;
}

/**
 * Why a command about the open product cannot run, or `undefined` when it can.
 * `needsEngine` for one that asks the engine (Generate, Add gear).
 */
export function productCommandRefusal(state: ProductCommandState, needsEngine = false): string | undefined {
  if (!state.productOpen) return state.opening ? STILL_OPENING : NO_PRODUCT;
  if (needsEngine && !state.engineConnected) return ENGINE_DOWN;
  return undefined;
}

/**
 * Why Resolve cannot run now: a product must be open and the engine up, since
 * resolving is asking the engine again.
 */
export function resolveRefusal(state: ProductCommandState): string | undefined {
  return productCommandRefusal(state, true);
}

/**
 * What Add gear does from here.
 *
 * With no product open it brings the Product view forward: a gear goes *into*
 * a product, and that view's empty state lists the products in the workspace,
 * Recent, New and Open -- so the person picks the product to add to, or makes
 * one. It used to open New Product straight away, which read as "Add gear
 * makes a product" to someone who had a product and had not opened it yet.
 */
export type AddGearEntrance =
  | { readonly kind: "add" }
  | { readonly kind: "choose-product" }
  | { readonly kind: "unavailable"; readonly reason: string };

export function addGearEntrance(state: ProductCommandState): AddGearEntrance {
  if (!state.engineConnected) return { kind: "unavailable", reason: ENGINE_DOWN };
  if (state.productOpen) return { kind: "add" };
  if (state.opening) return { kind: "unavailable", reason: STILL_OPENING };
  return { kind: "choose-product" };
}
