// The Studio colour themes: Theia's palette taken from the portal's (#1073).
//
// The portal draws with the kit's tokens; the IDE it embeds drew with Theia's
// stock themes and the product extension's own hand-picked palette, so the
// page showed two colour schemes. These two themes are the portal's tokens
// mapped onto Theia's colour keys. The token values are not written here:
// `portal-tokens.json` is generated from the kit's theme.css by
// studio-frontend-prototype/scripts/generate-ide-theme-tokens.ts, and a test
// there fails when it falls behind the kit. A token change reaches both sides
// by regenerating that one file.
//
// Everything in this module is pure, so the mapping is tested without Theia.

import portalTokens = require('./portal-tokens.json');

export type StudioThemeMode = 'light' | 'dark';

/** A portal palette: token name (no leading `--`) to `#rrggbb`. */
export type PortalPalette = Readonly<Record<string, string>>;

export interface PortalTypography {
    readonly fontSans: string;
    readonly fontMono: string;
    readonly bodySize: string;
    readonly labelSize: string;
}

export interface PortalTokens {
    readonly source: { readonly package: string; readonly version: string };
    readonly typography: PortalTypography;
    readonly light: PortalPalette;
    readonly dark: PortalPalette;
}

export const PORTAL_TOKENS: PortalTokens = portalTokens;

export const STUDIO_LIGHT_THEME_ID = 'studio-light';
export const STUDIO_DARK_THEME_ID = 'studio-dark';

export function studioThemeId(mode: StudioThemeMode): string {
    return mode === 'light' ? STUDIO_LIGHT_THEME_ID : STUDIO_DARK_THEME_ID;
}

/** The mode of a Studio theme id, or undefined for any other theme. */
export function studioThemeMode(themeId: string | undefined): StudioThemeMode | undefined {
    return themeId === STUDIO_LIGHT_THEME_ID ? 'light' : themeId === STUDIO_DARK_THEME_ID ? 'dark' : undefined;
}

function token(palette: PortalPalette, name: string): string {
    const value = palette[name];
    if (!value) {
        throw new Error(`portal palette has no --${name}`);
    }
    return value.toLowerCase();
}

function channels(hex: string): [number, number, number] {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * `weight` of `a` over `b`, as `#rrggbb` — the hex form of the portal's own
 * `color-mix(in srgb, a weight%, b)`. Theia's colour keys take literal colours,
 * so where the portal mixes, the theme mixes the same two tokens here.
 */
export function mix(a: string, b: string, weight: number): string {
    const ca = channels(a);
    const cb = channels(b);
    return '#' + ca.map((v, i) => Math.round(v * weight + cb[i] * (1 - weight)).toString(16).padStart(2, '0')).join('');
}

/** `hex` at `alpha` (0..1), as `#rrggbbaa`. */
export function withAlpha(hex: string, alpha: number): string {
    return hex.slice(0, 7) + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

/**
 * The portal palette as Theia (VS Code) colour keys.
 *
 * The portal's layout gives the roles: the page is `background`, what sits on
 * it — header, tab bar, cards, the document — is `card`; the navigation is
 * `sidebar`; the accent is `primary`; a selected row is `selection-subtle`;
 * a focused control rings in `ring`. The IDE takes the same roles: the editor
 * and its active tab are the document (card), the frame around it — activity
 * bar, tab strip, status bar — is the page (background), the side bar is the
 * sidebar.
 */
export function toTheiaColors(palette: PortalPalette): Record<string, string> {
    const t = (name: string) => token(palette, name);
    const background = t('background');
    const foreground = t('foreground');
    const card = t('card');
    const muted = t('muted-foreground');
    const border = t('border');
    const borderStrong = t('border-strong');
    const primary = t('primary');
    const onPrimary = t('primary-foreground');
    const selection = t('selection-subtle');
    const hover = t('card-hover');
    const secondary = t('secondary');
    const sidebar = t('sidebar');
    const ring = t('ring');
    const link = t('link-foreground');
    const popover = t('popover');
    const danger = t('danger');
    const warning = t('warning');
    const info = t('info');
    const success = t('success');
    return {
        // Base
        'foreground': foreground,
        'descriptionForeground': muted,
        'disabledForeground': mix(muted, card, 0.6),
        'errorForeground': danger,
        'icon.foreground': muted,
        'focusBorder': ring,
        'contrastBorder': border,
        'widget.border': border,
        'widget.shadow': withAlpha(foreground, 0.16),
        'selection.background': selection,
        'sash.hoverBorder': primary,
        'textLink.foreground': link,
        'textLink.activeForeground': t('primary-hover'),
        'progressBar.background': primary,
        'badge.background': primary,
        'badge.foreground': onPrimary,
        'scrollbarSlider.background': withAlpha(borderStrong, 0.6),
        'scrollbarSlider.hoverBackground': withAlpha(mix(muted, borderStrong, 0.4), 0.7),
        'scrollbarSlider.activeBackground': withAlpha(muted, 0.7),
        'toolbar.hoverBackground': secondary,
        'toolbar.activeBackground': selection,

        // Editor: the document, a card on the page
        'editor.background': card,
        'editor.foreground': foreground,
        'editor.selectionBackground': selection,
        'editor.inactiveSelectionBackground': mix(selection, card, 0.6),
        'editor.lineHighlightBackground': hover,
        'editor.lineHighlightBorder': hover,
        'editorCursor.foreground': primary,
        'editorLineNumber.foreground': mix(muted, card, 0.6),
        'editorLineNumber.activeForeground': foreground,
        'editorIndentGuide.background1': border,
        'editorIndentGuide.activeBackground1': borderStrong,
        'editorWhitespace.foreground': borderStrong,
        'editorGutter.background': card,
        'editorWidget.background': popover,
        'editorWidget.foreground': t('popover-foreground'),
        'editorWidget.border': border,
        'editorSuggestWidget.background': popover,
        'editorSuggestWidget.border': border,
        'editorSuggestWidget.selectedBackground': selection,
        'editorSuggestWidget.highlightForeground': link,
        'editorHoverWidget.background': popover,
        'editorHoverWidget.border': border,
        'editorError.foreground': danger,
        'editorWarning.foreground': warning,
        'editorInfo.foreground': info,
        'editorLink.activeForeground': link,

        // The frame: tab strip, activity bar, title and status bars are the page
        'editorGroup.border': border,
        'editorGroupHeader.tabsBackground': background,
        'editorGroupHeader.tabsBorder': border,
        'tab.activeBackground': card,
        'tab.activeForeground': foreground,
        'tab.activeBorderTop': primary,
        'tab.unfocusedActiveBorderTop': borderStrong,
        'tab.inactiveBackground': background,
        'tab.inactiveForeground': muted,
        'tab.hoverBackground': hover,
        'tab.border': border,
        'activityBar.background': background,
        'activityBar.foreground': foreground,
        'activityBar.inactiveForeground': muted,
        'activityBar.border': border,
        'activityBar.activeBorder': primary,
        'activityBarBadge.background': primary,
        'activityBarBadge.foreground': onPrimary,
        'titleBar.activeBackground': card,
        'titleBar.activeForeground': foreground,
        'titleBar.inactiveBackground': card,
        'titleBar.inactiveForeground': muted,
        'titleBar.border': border,
        'statusBar.background': background,
        'statusBar.foreground': muted,
        'statusBar.border': border,
        'statusBar.noFolderBackground': background,
        'statusBar.debuggingBackground': primary,
        'statusBar.debuggingForeground': onPrimary,
        'statusBarItem.hoverBackground': secondary,
        'statusBarItem.activeBackground': selection,
        'statusBarItem.prominentBackground': primary,
        'statusBarItem.prominentForeground': onPrimary,
        'statusBarItem.remoteBackground': primary,
        'statusBarItem.remoteForeground': onPrimary,

        // Side bar: the portal's navigation
        'sideBar.background': sidebar,
        'sideBar.foreground': t('sidebar-foreground'),
        'sideBar.border': t('sidebar-border'),
        'sideBarTitle.foreground': foreground,
        'sideBarSectionHeader.background': sidebar,
        'sideBarSectionHeader.foreground': foreground,
        'sideBarSectionHeader.border': border,

        // Panel
        'panel.background': card,
        'panel.border': border,
        'panelTitle.activeForeground': foreground,
        'panelTitle.activeBorder': primary,
        'panelTitle.inactiveForeground': muted,
        'panelInput.border': t('input'),
        'terminal.background': card,
        'terminal.foreground': foreground,

        // Lists and trees
        'list.activeSelectionBackground': selection,
        'list.activeSelectionForeground': foreground,
        'list.inactiveSelectionBackground': selection,
        'list.inactiveSelectionForeground': foreground,
        'list.hoverBackground': hover,
        'list.focusBackground': selection,
        'list.focusOutline': ring,
        'list.highlightForeground': link,
        'tree.indentGuidesStroke': borderStrong,

        // Inputs
        'input.background': card,
        'input.foreground': foreground,
        'input.border': t('input'),
        'input.placeholderForeground': muted,
        'inputOption.activeBorder': ring,
        'inputOption.activeBackground': selection,
        'inputValidation.errorBorder': danger,
        'inputValidation.warningBorder': warning,
        'inputValidation.infoBorder': info,
        'dropdown.background': card,
        'dropdown.foreground': foreground,
        'dropdown.border': t('input'),
        'dropdown.listBackground': popover,
        'checkbox.background': card,
        'checkbox.border': t('input'),
        'checkbox.foreground': foreground,

        // Buttons
        'button.background': primary,
        'button.foreground': onPrimary,
        'button.hoverBackground': t('primary-hover'),
        'button.border': primary,
        'button.secondaryBackground': secondary,
        'button.secondaryForeground': t('secondary-foreground'),
        'button.secondaryHoverBackground': mix(secondary, foreground, 0.92),
        'secondaryButton.background': secondary,
        'secondaryButton.foreground': t('secondary-foreground'),
        'secondaryButton.hoverBackground': mix(secondary, foreground, 0.92),

        // Menus, pickers, notifications: the portal's popovers
        'menu.background': popover,
        'menu.foreground': t('popover-foreground'),
        'menu.border': border,
        'menu.selectionBackground': selection,
        'menu.selectionForeground': foreground,
        'menu.separatorBackground': border,
        'menubar.selectionBackground': secondary,
        'quickInput.background': popover,
        'quickInput.foreground': t('popover-foreground'),
        'quickInputTitle.background': background,
        'quickInputList.focusBackground': selection,
        'quickInputList.focusForeground': foreground,
        'pickerGroup.foreground': link,
        'pickerGroup.border': border,
        'notifications.background': popover,
        'notifications.foreground': t('popover-foreground'),
        'notifications.border': border,
        'notificationCenterHeader.background': background,
        'notificationToast.border': border,
        'notificationLink.foreground': link,
        'notificationsInfoIcon.foreground': info,
        'notificationsWarningIcon.foreground': warning,
        'notificationsErrorIcon.foreground': danger,

        // Source control colours on the portal's status tones
        'gitDecoration.addedResourceForeground': success,
        'gitDecoration.untrackedResourceForeground': success,
        'gitDecoration.modifiedResourceForeground': warning,
        'gitDecoration.deletedResourceForeground': danger,
        'gitDecoration.conflictingResourceForeground': danger,
        'gitDecoration.ignoredResourceForeground': mix(muted, card, 0.6),
    };
}

/**
 * The product extension (theia/product-ext) paints its own surfaces — the
 * document editor, rails, the status line — and re-points several Theia keys
 * from a palette of `--studio-*` custom properties. While a Studio theme is on,
 * that palette takes the portal's values too, or those surfaces would keep the
 * other colour scheme. The roles match `toTheiaColors`.
 */
export function toProductPalette(palette: PortalPalette, typography: PortalTypography): Record<string, string> {
    const t = (name: string) => token(palette, name);
    return {
        '--studio-bg': t('card'),
        '--studio-surface': t('sidebar'),
        '--studio-surface-raised': t('card-hover'),
        '--studio-surface-sunken': t('secondary'),
        '--studio-chrome': t('background'),
        '--studio-line': t('border'),
        '--studio-edge': t('border-strong'),
        '--studio-text': t('foreground'),
        '--studio-muted': t('muted-foreground'),
        '--studio-accent': t('primary'),
        '--studio-on-accent': t('primary-foreground'),
        '--studio-accent-hover': t('primary-hover'),
        '--studio-selection-bg': t('selection-subtle'),
        '--studio-mark': t('primary'),
        '--studio-danger': t('danger'),
        '--studio-warning': t('warning-foreground'),
        '--studio-verified': t('success-foreground'),
        '--studio-loader-on': t('primary'),
        '--studio-loader-off': t('border'),
        '--studio-scrollbar': t('border-strong'),
        '--studio-scrollbar-hover': mix(t('muted-foreground'), t('border-strong'), 0.4),
        '--studio-scrollbar-active': t('muted-foreground'),
        '--studio-mono': typography.fontMono,
    };
}

/** The chrome's type, from the portal's: Theia's family and base size. */
export function toTheiaTypography(typography: PortalTypography): Record<string, string> {
    return {
        '--theia-ui-font-family': typography.fontSans,
        '--theia-ui-font-size1': typography.bodySize,
    };
}

/** A VS Code colour theme document for one mode, for `MonacoThemingService.registerParsedTheme`. */
export function studioThemeJson(mode: StudioThemeMode, tokens: PortalTokens = PORTAL_TOKENS): { include: string; colors: Record<string, string> } {
    return {
        // Theia's own syntax colours, so code keeps its highlighting.
        include: mode === 'light' ? './light_theia.json' : './dark_theia.json',
        colors: toTheiaColors(tokens[mode]),
    };
}

const PALETTE_ATTRIBUTE = 'data-studio-portal-theme';

/**
 * The stylesheet that puts the portal's palette and type on the product
 * extension's surfaces while a Studio theme is on. Keyed on an attribute of
 * `<html>` so the `:root` rules that read `--studio-*` resolve against these
 * values, and repeated on `body` so it outranks the extension's own
 * `body[data-studio-theme="dark"]` block and its brand sheet; `!important`
 * because the brand accent is an inline property of `<html>`.
 */
export function studioThemeCss(tokens: PortalTokens = PORTAL_TOKENS): string {
    const block = (mode: StudioThemeMode) => {
        const decls = { ...toProductPalette(tokens[mode], tokens.typography), ...toTheiaTypography(tokens.typography) };
        const body = Object.entries(decls).map(([name, value]) => `  ${name}: ${value} !important;`).join('\n');
        const sel = `html[${PALETTE_ATTRIBUTE}="${mode}"]`;
        return `${sel},\n${sel} body {\n${body}\n}`;
    };
    const sel = `html[${PALETTE_ATTRIBUTE}]`;
    return [
        block('light'),
        block('dark'),
        // The product extension writes the chrome's family and size on body
        // and the shell directly; the portal's win while a Studio theme is on.
        `${sel} body,\n${sel} .theia-ApplicationShell {\n  font-family: var(--theia-ui-font-family) !important;\n  font-size: var(--theia-ui-font-size1) !important;\n}`,
    ].join('\n\n') + '\n';
}

export { PALETTE_ATTRIBUTE as STUDIO_PORTAL_THEME_ATTRIBUTE };
