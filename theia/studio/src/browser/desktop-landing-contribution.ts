// Puts the desktop landing page in the main area while the window has no
// Studio project open, and takes it away when it has one (ADR-0027).
//
// HOW IT MEETS THE START PAGE. product-ext's start page (welcome-view.js) is a
// layer of the EMPTY main dock: it shows exactly when the dock holds no widget.
// The landing is a widget in that dock, so while it is there the start page
// yields by its own rule, and the moment it is gone -- a real project or folder
// is open -- the start page is back, unchanged. product-ext is not touched.
//
// Bound only by the desktop app's electron module (bindDesktopLanding): a
// session never loads it. It also keeps the "Workspace source suggestion"
// notification quiet about the placeholder folder, which is not the member's
// work (DesktopStartFolderGate).

import { inject, injectable, interfaces, optional } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { WidgetFactory, WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { CommonMenus } from '@theia/core/lib/browser/common-menus';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import type { WorkspaceRepositorySuggestion } from '../common/workspace-protocol';
import { desktopStatus } from './desktop-studio-widget';
import { DESKTOP_LANDING_WIDGET_ID, DesktopLandingWidget } from './desktop-landing-widget';
import { LandingStatus, landingWanted, sameFolder } from './desktop-landing-state';
import { WorkspaceSuggestionGate } from './workspace-suggestion-gate';
import '../../src/browser/desktop-landing.css';

export const DesktopWelcomeCommand: Command = {
    id: 'studio.desktop.welcome',
    category: 'Constructor Studio',
    label: 'Welcome',
};

@injectable()
export class DesktopLandingContribution implements FrontendApplicationContribution, CommandContribution, MenuContribution {
    @inject(FrontendApplicationStateService)
    protected readonly appState: FrontendApplicationStateService;

    @inject(WidgetManager)
    protected readonly widgets: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    /** Opened from Help → Welcome: it stays until closed, whatever the folder. */
    protected byHand = false;

    onStart(): void {
        void this.appState.reachedState('ready').then(async () => {
            await this.ensure(true);
            // A mode switch lays the dock out again and may drop the page; a
            // folder change may make it right or wrong.
            this.perspectives?.onDidChangePerspective(() => void this.ensure(false));
            this.workspaceService.onWorkspaceChanged(() => void this.ensure(false));
        });
    }

    /** Whether this window has no Studio project open, as the backend's start folder says. */
    async wanted(): Promise<boolean> {
        const status = await desktopStatus() as LandingStatus | undefined;
        const root = this.workspaceService.tryGetRoots()[0]?.resource.path.fsPath();
        return landingWanted(status, root);
    }

    /** Show the page when the window wants it, take it away when not. */
    async ensure(activate: boolean): Promise<void> {
        const wanted = await this.wanted();
        const existing = this.widgets.tryGetWidget<DesktopLandingWidget>(DESKTOP_LANDING_WIDGET_ID);
        if (!wanted) {
            // A layout restored from an earlier start may carry it into a project.
            if (existing && !this.byHand) {
                existing.close();
            }
            return;
        }
        const widget = await this.show(activate);
        // Closing it would only uncover the placeholder's start page.
        widget.title.closable = false;
    }

    protected async show(activate: boolean): Promise<DesktopLandingWidget> {
        const widget = await this.widgets.getOrCreateWidget<DesktopLandingWidget>(DESKTOP_LANDING_WIDGET_ID);
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        if (activate) {
            await this.shell.activateWidget(widget.id);
        }
        return widget;
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(DesktopWelcomeCommand, {
            execute: async () => {
                const wanted = await this.wanted();
                this.byHand = !wanted;
                const widget = await this.show(true);
                widget.title.closable = !wanted;
                widget.showOnboarding();
                // Closed by hand: from then on the folder decides again.
                widget.disposed.connect(() => { this.byHand = false; });
            },
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.HELP, {
            commandId: DesktopWelcomeCommand.id,
            label: 'Welcome',
            order: 'a0',
        });
    }
}

/** Keeps the "Workspace source suggestion" notification quiet about the desktop's placeholder folder. */
@injectable()
export class DesktopStartFolderGate implements WorkspaceSuggestionGate {
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    async suppresses(suggestion: WorkspaceRepositorySuggestion): Promise<boolean> {
        const status = await desktopStatus() as LandingStatus | undefined;
        const start = status?.enabled ? status.startFolder : undefined;
        if (!start) {
            return false;
        }
        const root = this.workspaceService.tryGetRoots()[0]?.resource.path.fsPath();
        return sameFolder(root, start) || sameFolder(suggestion.rootPath, start) || sameFolder(suggestion.localPath, start);
    }
}

/** The landing's bindings, for the desktop app's electron frontend module only. */
export function bindDesktopLanding(bind: interfaces.Bind): void {
    // Not a singleton: a closed page is disposed, and the next one is new.
    bind(DesktopLandingWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: DESKTOP_LANDING_WIDGET_ID,
        createWidget: () => ctx.container.get<DesktopLandingWidget>(DesktopLandingWidget),
    })).inSingletonScope();
    bind(DesktopLandingContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(DesktopLandingContribution);
    bind(CommandContribution).toService(DesktopLandingContribution);
    bind(MenuContribution).toService(DesktopLandingContribution);
    bind(DesktopStartFolderGate).toSelf().inSingletonScope();
    bind(WorkspaceSuggestionGate).toService(DesktopStartFolderGate);
}
