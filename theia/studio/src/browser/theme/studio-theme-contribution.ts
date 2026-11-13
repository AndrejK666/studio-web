// Registers the Studio colour themes and keeps the product's own surfaces on
// the portal's palette while one of them is on (#1073).
//
// The themes are registered the way Theia registers its own built-in ones and
// a plugin registers a contributed one: a parsed VS Code theme document handed
// to MonacoThemingService, which defines the Monaco theme and registers the
// Theia theme with ThemeService. They include Theia's own light/dark theme
// documents for syntax colours, so code keeps its highlighting and only the
// workbench colours change.

import { inject, injectable } from '@theia/core/shared/inversify';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { MonacoThemingService } from '@theia/monaco/lib/browser/monaco-theming-service';
import {
    STUDIO_PORTAL_THEME_ATTRIBUTE,
    StudioThemeMode,
    studioThemeCss,
    studioThemeId,
    studioThemeJson,
    studioThemeMode,
} from './studio-color-themes';

const STYLE_ID = 'studio-portal-theme';

/** Theia's own theme documents, which the Studio themes include for syntax colours. */
function theiaThemeIncludes(mode: StudioThemeMode): Record<string, unknown> {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return mode === 'light'
        ? {
            './light_theia.json': require('@theia/monaco/data/monaco-themes/vscode/light_theia.json'),
            './light_vs.json': require('@theia/monaco/data/monaco-themes/vscode/light_vs.json'),
            './light_plus.json': require('@theia/monaco/data/monaco-themes/vscode/light_plus.json'),
        }
        : {
            './dark_theia.json': require('@theia/monaco/data/monaco-themes/vscode/dark_theia.json'),
            './dark_vs.json': require('@theia/monaco/data/monaco-themes/vscode/dark_vs.json'),
            './dark_plus.json': require('@theia/monaco/data/monaco-themes/vscode/dark_plus.json'),
        };
    /* eslint-enable @typescript-eslint/no-require-imports */
}

@injectable()
export class StudioThemeContribution implements FrontendApplicationContribution {

    @inject(MonacoThemingService)
    protected readonly monacoTheming: MonacoThemingService;

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    protected readonly toDispose = new DisposableCollection();

    /**
     * In `initialize`, not `onStart`: every contribution has been constructed by
     * then, Monaco's theming included, and a theme registered this early is
     * there when the stored `workbench.colorTheme` is validated, so a session
     * that last ran in a Studio theme opens in it.
     */
    initialize(): void {
        for (const mode of ['light', 'dark'] as const) {
            this.toDispose.push(this.monacoTheming.registerParsedTheme({
                id: studioThemeId(mode),
                label: mode === 'light' ? 'Studio Light' : 'Studio Dark',
                description: 'The Studio portal\'s palette',
                uiTheme: mode === 'light' ? 'vs' : 'vs-dark',
                json: studioThemeJson(mode),
                includes: theiaThemeIncludes(mode),
            }));
        }
        this.toDispose.push(this.themeService.onDidColorThemeChange(() => this.applyPalette()));
        this.applyPalette();
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    /** The product's surfaces and the chrome's type follow while a Studio theme is on. */
    protected applyPalette(): void {
        const mode = studioThemeMode(this.themeService.getCurrentTheme().id);
        const root = document.documentElement;
        if (!mode) {
            root.removeAttribute(STUDIO_PORTAL_THEME_ATTRIBUTE);
            return;
        }
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = studioThemeCss();
            // Last in <head>, after the stylesheets it has to outrank on a tie.
            document.head.appendChild(style);
            this.toDispose.push({ dispose: () => style.remove() });
        }
        root.setAttribute(STUDIO_PORTAL_THEME_ATTRIBUTE, mode);
    }
}
