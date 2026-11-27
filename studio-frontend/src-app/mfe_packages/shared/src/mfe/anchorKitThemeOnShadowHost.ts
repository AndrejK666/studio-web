/**
 * Re-anchors the ui-kit theme stylesheet on a Shadow DOM host.
 *
 * A ShadowRoot is a DocumentFragment, so a `:root` block delivers nothing
 * inside it — the kit's tokens must be re-anchored on `:host` to reach the
 * mounted screen. Comments are stripped first so `:root` inside a comment
 * cannot produce a phantom rule; the rewrite then anchors on /:root\b/g,
 * covering minified single-line CSS and `selector,:root` lists.
 *
 * `:root:not([data-theme='light'])` becomes `:host:not(...)`, which never
 * matches (a shadow host is featureless to non-functional compound
 * selectors) — deliberate: the kit's prefers-color-scheme fallback must not
 * leak through.
 *
 * The palette blocks, `[data-theme='light']` and `[data-theme='dark']`, also
 * match the host when it carries `data-kit-theme` (`KIT_THEME_HOST_ATTR`),
 * which `StudioMfeLifecycle` keeps in step with the portal's theme. Every
 * screen of the MFE then takes the portal's palette from its host, whether or
 * not its own root carries `data-theme` (#1075), and so does a popup portalled
 * to the shadow root, outside every screen root. The kit's `[data-theme]`
 * paint rule is left alone: the host stays transparent over the shell's page.
 * A different attribute on the host, not `data-theme`, because the shell's
 * document carries the kit theme too, and its `[data-theme]` rule would paint
 * the host from outside, where `:host` rules lose.
 */
export const KIT_THEME_HOST_ATTR = 'data-kit-theme';

/**
 * A palette block's selector, alone in its list item: `[data-theme='dark']`, with either
 * quotes or none, as the minified `?inline` theme of a production build has it.
 */
const PALETTE_SELECTOR = /(^|[,{}\s])(\[data-theme=(['"]?)(light|dark)\3\])(?=\s*[,{])/g;

export function anchorKitThemeOnShadowHost(css: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutComments
    .replace(/:root\b/g, ':host')
    .replace(
      PALETTE_SELECTOR,
      (_match, before: string, selector: string, _quote: string, palette: string) =>
        `${before}:host([${KIT_THEME_HOST_ATTR}='${palette}']),${selector}`
    );
}
