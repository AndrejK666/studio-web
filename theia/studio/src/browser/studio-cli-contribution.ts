// The Constructor Studio CLI's commands: the ribbon's CLI group
// (studio-mode-bar.tsx) and the command palette, in a session and on the
// desktop alike. Each runs `cfs` on the backend in the open checkout, logs
// everything to the "Constructor Studio CLI" Output channel, and says in one
// notification how it went, with the log a click away.

import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, type Command } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickInputService } from '@theia/core/lib/common/quick-pick-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { OutputChannelManager, OutputChannelSeverity } from '@theia/output/lib/browser/output-channel';
import {
    STUDIO_CLI_COMMANDS,
    StudioCliService,
    type StudioCliCommandId,
    type StudioCliTarget,
} from '../common/studio-cli-protocol';
import { logOfCliRun, STUDIO_CLI_LABELS, summarizeCliRun } from '../common/studio-cli-report';

export const STUDIO_CLI_CHANNEL = 'Constructor Studio CLI';
const SHOW_LOG = 'Show log';
const INITIALIZE = 'Initialize';

/** `studio.cli.validate`, … -- the ids the ribbon names. */
export function studioCliCommandId(command: StudioCliCommandId): string {
    return `studio.cli.${command}`;
}

export const STUDIO_CLI_COMMAND_DEFINITIONS: readonly (Command & { readonly cli: StudioCliCommandId })[] = STUDIO_CLI_COMMANDS.map(cli => ({
    id: studioCliCommandId(cli),
    category: 'Constructor Studio CLI',
    label: STUDIO_CLI_LABELS[cli].label,
    cli,
}));

@injectable()
export class StudioCliContribution implements CommandContribution {
    @inject(StudioCliService) protected readonly cli!: StudioCliService;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(QuickInputService) protected readonly quickInput!: QuickInputService;
    @inject(OutputChannelManager) protected readonly output!: OutputChannelManager;

    /** One run at a time: two `cfs` in one checkout would fight over its cache. */
    protected running: StudioCliCommandId | undefined;

    registerCommands(commands: CommandRegistry): void {
        for (const definition of STUDIO_CLI_COMMAND_DEFINITIONS) {
            commands.registerCommand(definition, {
                isEnabled: () => this.running === undefined && this.roots().length > 0,
                // Read by the ribbon (`ribbonAction`) to say why it is disabled.
                disabledReason: () => this.running !== undefined
                    ? `cfs ${this.running} is running`
                    : 'open a project first',
                execute: () => this.runCommand(definition.cli),
            } as Parameters<CommandRegistry['registerCommand']>[1]);
        }
    }

    protected roots(): string[] {
        return this.workspace.tryGetRoots().map(root => root.resource.path.fsPath());
    }

    async runCommand(command: StudioCliCommandId): Promise<void> {
        if (this.running !== undefined) {
            return;
        }
        this.running = command;
        const channel = this.output.getChannel(STUDIO_CLI_CHANNEL);
        const progress = await this.messages.showProgress({ text: `cfs ${command === 'version' ? '--version' : command}…` });
        try {
            const target = await this.target();
            if (!target) {
                return;
            }
            const run = await this.cli.run(command, target.path);
            const summary = summarizeCliRun(run, target.name);
            for (const line of logOfCliRun(run)) {
                channel.appendLine(line);
            }
            progress.cancel();
            // Every command but init and version needs a prepared checkout, and
            // cfs says so in a line the member then has to act on by hand.
            const offerInit = !target.initialized && run.exitCode !== 0 && command !== 'init' && command !== 'version';
            this.tell(summary.level, summary.text, () => channel.show({ preserveFocus: true }),
                offerInit ? { label: INITIALIZE, run: () => this.runCommand('init') } : undefined);
        } catch (error) {
            const text = `cfs ${command}: ${error instanceof Error ? error.message : String(error)}`;
            channel.appendLine(`✗ ${text}`, OutputChannelSeverity.Error);
            progress.cancel();
            this.tell('error', text, () => channel.show({ preserveFocus: true }));
        } finally {
            progress.cancel();
            this.running = undefined;
        }
    }

    /** The checkout to run in: the only one, or the one the member picks. */
    protected async target(): Promise<StudioCliTarget | undefined> {
        const found: StudioCliTarget[] = [];
        for (const root of this.roots()) {
            found.push(...await this.cli.targets(root));
        }
        if (found.length === 0) {
            this.messages.warn('Constructor Studio CLI: the open folder holds no checkout (no .git or .cf-studio in it or beside it).');
            return undefined;
        }
        if (found.length === 1) {
            return found[0];
        }
        const picked = await this.quickInput.showQuickPick(
            found.map(target => ({ label: target.name, description: target.initialized ? 'Constructor Studio' : 'not initialized', detail: target.path, target })),
            { placeholder: 'Which checkout to run cfs in' },
        );
        return picked?.target;
    }

    /** Not awaited by the command: the notification answers only when it is closed. */
    protected tell(
        level: 'info' | 'warning' | 'error',
        text: string,
        showLog: () => void,
        next?: { readonly label: string; readonly run: () => Promise<void> },
    ): void {
        const actions = next ? [next.label, SHOW_LOG] : [SHOW_LOG];
        const shown = level === 'error'
            ? this.messages.error(text, ...actions)
            : level === 'warning' ? this.messages.warn(text, ...actions) : this.messages.info(text, ...actions);
        void shown.then(action => {
            if (action === SHOW_LOG) {
                showLog();
            } else if (next && action === next.label) {
                void next.run();
            }
        });
    }
}
