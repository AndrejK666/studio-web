// The empty main dock's page registry, from this side.
//
// The layer that paints the empty dock is product-ext's (welcome-view.js), and
// its registry is `theia/product-ext/src/browser/start-pages.js`, which says
// what a page is. This package does not import product-ext, so it meets the
// registry the way that file documents: a plain object under a well-known
// symbol, created by whichever side touches it first. These are those two
// lines, typed. gearbox-studio carries the same few lines for its Building page.

export interface StartRow {
    readonly name: string;
    readonly detail?: string;
    readonly folder?: string;
    readonly meta?: string;
    /** A short accent label: why the row is on the list. */
    readonly tag?: string;
    readonly title?: string;
    /** A uri the row opens. */
    readonly open?: string;
    /** Or a command it runs, drawn disabled when the command is. */
    readonly command?: string;
    readonly args?: unknown[];
    /** Or what the page does itself. */
    readonly activate?: () => unknown;
    /** The page's own "cannot now", drawn disabled with `reason`. */
    readonly enabled?: boolean;
    readonly reason?: string;
}

export interface StartSection {
    readonly id: string;
    readonly title: string;
    readonly count?: string;
    /** Which of the grid's two columns; alternates when absent. */
    readonly column?: 0 | 1;
    readonly rows: readonly StartRow[];
    /** What an empty section says: never a blank. */
    readonly empty?: string;
    readonly note?: string;
    readonly more?: number;
    readonly moreAction?: StartAction;
}

export interface StartAction {
    readonly id?: string;
    readonly label: string;
    readonly title?: string;
    readonly command?: string;
    readonly args?: unknown[];
    readonly activate?: () => unknown;
    /** The page's own "cannot now", for what the command cannot know. */
    readonly enabled?: boolean;
    readonly reason?: string;
    readonly kbd?: string;
}

export interface StartPageContext {
    readonly token: { readonly cancelled: boolean };
    /** The active project's root, as a Theia URI; undefined with no project open. */
    readonly root: { toString(): string; readonly path: { readonly base: string; fsPath(): string } } | undefined;
    readonly rootString: string;
    readonly projectName: string;
    /** A section another package registered; undefined when none did. */
    section(id: string): Promise<StartSection | undefined>;
}

export interface StartPageModel {
    readonly sections: readonly StartSection[];
    readonly actions?: readonly StartAction[];
    readonly foot?: string;
}

export interface StartPage {
    readonly id: string;
    /** The perspective ids (studio-modes.ts) the page is shown in. */
    readonly modes: readonly string[];
    readonly label: string;
    readonly summary?: string;
    readonly actions?: readonly StartAction[];
    /** False: a file saved while the page is on screen does not re-read it. */
    readonly reloadOnFileChange?: boolean;
    load(ctx: StartPageContext): Promise<StartPageModel>;
    watch?(reload: () => void): { dispose(): void };
}

export interface StartSectionProvider {
    readonly id: string;
    readonly title: string;
    load(ctx: StartPageContext): Promise<StartSection>;
}

interface Hub {
    pages: StartPage[];
    sections: StartSectionProvider[];
    listeners: Array<() => void>;
}

const HUB_KEY = Symbol.for('studio.start-pages.v1');

function hub(scope: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>): Hub {
    const found = scope[HUB_KEY] as Partial<Hub> | undefined;
    const it: Hub = {
        pages: Array.isArray(found?.pages) ? found.pages : [],
        sections: Array.isArray(found?.sections) ? found.sections : [],
        listeners: Array.isArray(found?.listeners) ? found.listeners : [],
    };
    if (found && typeof found === 'object') {
        Object.assign(found, it);
        return found as Hub;
    }
    scope[HUB_KEY] = it;
    return it;
}

function add<T>(list: T[], item: T, into: Hub): { dispose(): void } {
    list.push(item);
    const notify = () => into.listeners.slice().forEach(listener => {
        try {
            listener();
        } catch {
            // one listener's failure is not the registry's
        }
    });
    notify();
    return {
        dispose: () => {
            const at = list.indexOf(item);
            if (at >= 0) {
                list.splice(at, 1);
                notify();
            }
        },
    };
}

export function registerStartPage(page: StartPage, scope?: Record<symbol, unknown>): { dispose(): void } {
    const into = hub(scope);
    return add(into.pages, page, into);
}

export function registerStartSection(section: StartSectionProvider, scope?: Record<symbol, unknown>): { dispose(): void } {
    const into = hub(scope);
    return add(into.sections, section, into);
}
