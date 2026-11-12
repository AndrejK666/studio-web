import {
    mix,
    PORTAL_TOKENS,
    STUDIO_DARK_THEME_ID,
    STUDIO_LIGHT_THEME_ID,
    studioThemeCss,
    studioThemeId,
    studioThemeJson,
    studioThemeMode,
    toProductPalette,
    toTheiaColors,
    toTheiaTypography,
    withAlpha,
} from './studio-color-themes';

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

/** The kit's values (ui-kit 0.4.10), stated here so a mapping change is a visible diff. */
const KIT = {
    light: {
        background: '#f1f5f9', foreground: '#0f172a', card: '#ffffff', primary: '#0065e3',
        border: '#e2e8f0', sidebar: '#f1f5f9', 'selection-subtle': '#dce7f2', ring: '#0065e3',
        'muted-foreground': '#334155', input: '#d9e2ec', 'primary-foreground': '#ffffff',
    },
    dark: {
        background: '#0f172a', foreground: '#ffffff', card: '#0f172a', primary: '#0065e3',
        border: '#334155', sidebar: '#0f172a', 'selection-subtle': '#26384b', ring: '#0065e3',
        'muted-foreground': '#94a3b8', input: '#334155', 'primary-foreground': '#ffffff',
    },
} as const;

describe('Studio theme ids', () => {
    it('names one theme per portal mode, and reads the mode back', () => {
        expect(studioThemeId('light')).toBe(STUDIO_LIGHT_THEME_ID);
        expect(studioThemeId('dark')).toBe(STUDIO_DARK_THEME_ID);
        expect(studioThemeMode(STUDIO_LIGHT_THEME_ID)).toBe('light');
        expect(studioThemeMode(STUDIO_DARK_THEME_ID)).toBe('dark');
        expect(studioThemeMode('light')).toBeUndefined();
        expect(studioThemeMode(undefined)).toBeUndefined();
    });
});

describe('the generated portal tokens', () => {
    it('come from the kit and carry both palettes', () => {
        expect(PORTAL_TOKENS.source.package).toBe('@gears-frontx/ui-kit');
        for (const mode of ['light', 'dark'] as const) {
            for (const [name, value] of Object.entries(KIT[mode])) {
                expect([mode, name, PORTAL_TOKENS[mode][name]]).toEqual([mode, name, value]);
            }
        }
    });
});

describe.each(['light', 'dark'] as const)('toTheiaColors, %s', mode => {
    const kit = KIT[mode];
    const colors = toTheiaColors(PORTAL_TOKENS[mode]);

    it('gives every key a literal colour Theia can parse', () => {
        for (const [key, value] of Object.entries(colors)) {
            expect([key, HEX.test(value)]).toEqual([key, true]);
        }
    });

    it.each([
        // the document is a card on the page
        ['editor.background', 'card'],
        ['editor.foreground', 'foreground'],
        ['tab.activeBackground', 'card'],
        ['panel.background', 'card'],
        ['titleBar.activeBackground', 'card'],
        ['input.background', 'card'],
        // the frame is the page
        ['activityBar.background', 'background'],
        ['statusBar.background', 'background'],
        ['editorGroupHeader.tabsBackground', 'background'],
        ['tab.inactiveBackground', 'background'],
        // navigation
        ['sideBar.background', 'sidebar'],
        // text
        ['foreground', 'foreground'],
        ['descriptionForeground', 'muted-foreground'],
        ['tab.inactiveForeground', 'muted-foreground'],
        // accent and focus
        ['button.background', 'primary'],
        ['button.foreground', 'primary-foreground'],
        ['badge.background', 'primary'],
        ['activityBarBadge.background', 'primary'],
        ['tab.activeBorderTop', 'primary'],
        ['focusBorder', 'ring'],
        ['list.focusOutline', 'ring'],
        // selection
        ['list.activeSelectionBackground', 'selection-subtle'],
        ['editor.selectionBackground', 'selection-subtle'],
        ['menu.selectionBackground', 'selection-subtle'],
        // borders
        ['panel.border', 'border'],
        ['editorGroup.border', 'border'],
        ['widget.border', 'border'],
        ['sideBar.border', 'border'],
        ['input.border', 'input'],
    ] as const)('%s is the portal’s --%s', (key, name) => {
        expect(colors[key]).toBe(kit[name]);
    });

    it('derives its mixes from portal tokens, never from a literal', () => {
        expect(colors['editorLineNumber.foreground']).toBe(mix(kit['muted-foreground'], kit.card, 0.6));
        expect(colors['scrollbarSlider.activeBackground']).toBe(withAlpha(kit['muted-foreground'], 0.7));
    });

    it('is a theme document that keeps Theia’s syntax colours', () => {
        const json = studioThemeJson(mode);
        expect(json.include).toBe(mode === 'light' ? './light_theia.json' : './dark_theia.json');
        expect(json.colors).toEqual(colors);
    });

    it('puts the product extension’s palette on the same tokens', () => {
        const product = toProductPalette(PORTAL_TOKENS[mode], PORTAL_TOKENS.typography);
        expect(product['--studio-bg']).toBe(colors['editor.background']);
        expect(product['--studio-chrome']).toBe(colors['statusBar.background']);
        expect(product['--studio-surface']).toBe(colors['sideBar.background']);
        expect(product['--studio-accent']).toBe(colors['button.background']);
        expect(product['--studio-selection-bg']).toBe(colors['list.activeSelectionBackground']);
        expect(product['--studio-line']).toBe(colors['panel.border']);
        expect(product['--studio-text']).toBe(colors.foreground);
    });

    it('fails on a palette missing a token, rather than painting nothing', () => {
        const { primary: _dropped, ...rest } = PORTAL_TOKENS[mode];
        expect(() => toTheiaColors(rest)).toThrow(/--primary/);
    });
});

describe('the chrome’s type', () => {
    it('takes the portal’s family and body size', () => {
        expect(toTheiaTypography(PORTAL_TOKENS.typography)).toEqual({
            '--theia-ui-font-family': PORTAL_TOKENS.typography.fontSans,
            '--theia-ui-font-size1': '0.875rem',
        });
        expect(PORTAL_TOKENS.typography.fontSans).toMatch(/^'Inter Variable'/);
    });
});

describe('studioThemeCss', () => {
    const css = studioThemeCss();

    it('keys each palette on the html attribute, and repeats it on body', () => {
        expect(css).toContain('html[data-studio-portal-theme="light"],\nhtml[data-studio-portal-theme="light"] body {');
        expect(css).toContain('html[data-studio-portal-theme="dark"],\nhtml[data-studio-portal-theme="dark"] body {');
    });

    it('writes the portal’s values, outranking the extension’s inline brand accent', () => {
        expect(css).toContain(`--studio-bg: ${KIT.dark.card} !important;`);
        expect(css).toContain(`--studio-accent: ${KIT.light.primary} !important;`);
        expect(css).toContain(`--theia-ui-font-family: ${PORTAL_TOKENS.typography.fontSans} !important;`);
    });
});

describe('mix and withAlpha', () => {
    it('mix in srgb, like the portal’s color-mix', () => {
        expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
        expect(mix('#0065e3', '#ffffff', 1)).toBe('#0065e3');
        expect(mix('#0065e3', '#ffffff', 0)).toBe('#ffffff');
    });

    it('appends alpha', () => {
        expect(withAlpha('#334155', 0.5)).toBe('#33415580');
        expect(withAlpha('#334155', 1)).toBe('#334155ff');
    });
});
