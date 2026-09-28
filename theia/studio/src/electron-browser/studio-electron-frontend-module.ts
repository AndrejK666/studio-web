// Frontend pieces that exist only in the desktop app: Theia loads this module
// for `electron-app` (the `frontendElectron` entry), never for a session's
// `browser-app`, so nothing here can reach the web.

import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { CommonMenus } from '@theia/core/lib/browser/common-menus';
import {
    CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MessageService, type Command
} from '@theia/core/lib/common';
import { ElectronIpcConnectionProvider } from '@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source';
import { DesktopUpdates, describeUpdateCheck, desktopUpdatesPath } from '../common/desktop-updates-protocol';

export const CheckForUpdatesCommand: Command = {
    id: 'studio.desktop.checkForUpdates',
    category: 'Constructor Studio',
    label: 'Check for Updates…'
};

@injectable()
export class CheckForUpdatesContribution implements CommandContribution, MenuContribution {

    @inject(DesktopUpdates)
    protected readonly updates!: DesktopUpdates;

    @inject(MessageService)
    protected readonly messages!: MessageService;

    protected checking = false;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(CheckForUpdatesCommand, {
            isEnabled: () => !this.checking,
            execute: () => this.check()
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.HELP, {
            commandId: CheckForUpdatesCommand.id,
            label: 'Check for Updates…',
            order: 'z1'
        });
    }

    async check(): Promise<void> {
        this.checking = true;
        try {
            const { level, text } = describeUpdateCheck(await this.updates.check());
            if (level === 'warn') {
                this.messages.warn(text);
            } else {
                this.messages.info(text);
            }
        } finally {
            this.checking = false;
        }
    }
}

export default new ContainerModule(bind => {
    bind(DesktopUpdates).toDynamicValue(ctx =>
        ElectronIpcConnectionProvider.createProxy<DesktopUpdates>(ctx.container, desktopUpdatesPath)
    ).inSingletonScope();
    bind(CheckForUpdatesContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(CheckForUpdatesContribution);
    bind(MenuContribution).toService(CheckForUpdatesContribution);
});
