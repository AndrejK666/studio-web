// Opens a project from the portal's "Open in desktop" link (ADR-0027 §6).
//
// Theia already turns the operating system's `cfstudio://` link into an open
// request in the window: `electron.uriScheme` registers the scheme, and the
// link arrives from a cold start and from a second launch alike. This is the
// handler it is offered to. It does what a member would do in the Studio view
// -- connect to the Studio the link names, sign in if they have to, clone the
// project's sources through Studio and open the folder -- so the link grants
// nothing a click would not.

import { inject, injectable } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OpenHandler } from '@theia/core/lib/browser/opener-service';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { DESKTOP_LINK_OPEN, DESKTOP_LINK_SCHEME, DesktopLink, environmentFor, isCurrent, parseDesktopLink } from '../common/desktop-link';
import { customEnvironment } from '../common/desktop-environments';
import { DesktopStatus, desktopStatus, desktopUrl } from './desktop-studio-widget';

/** How long a link waits for the member to finish signing in, in the browser. */
const SIGN_IN_BUDGET_MS = 5 * 60_000;

@injectable()
export class DesktopLinkHandler implements OpenHandler {
    readonly id = 'studio.desktop-link';

    @inject(MessageService)
    protected readonly messages: MessageService;

    @inject(WindowService)
    protected readonly windows: WindowService;

    @inject(WorkspaceService)
    protected readonly workspaces: WorkspaceService;

    canHandle(uri: URI): number {
        return uri.scheme === DESKTOP_LINK_SCHEME && uri.authority === DESKTOP_LINK_OPEN ? 500 : 0;
    }

    async open(uri: URI): Promise<object | undefined> {
        this.windows.focus();
        const link = parseDesktopLink(uri.toString(true));
        if (!link) {
            this.messages.error('Studio: this link does not name a project to open.');
            return undefined;
        }
        try {
            await this.follow(link);
        } catch (error) {
            this.messages.error(`Studio: ${link.name ?? 'the project'} could not be opened — ${error instanceof Error ? error.message : error}`);
        }
        return {};
    }

    protected async follow(link: DesktopLink): Promise<void> {
        const found = await desktopStatus();
        if (!found?.enabled) {
            throw new Error('this IDE is not a desktop Studio');
        }
        let status: DesktopStatus = found;
        if (!isCurrent(link, status.current)) {
            status = await this.connect(link, status);
        }
        if (status.state !== 'signed-in') {
            status = await this.signIn();
        }
        const title = link.name ?? link.project;
        const progress = await this.messages.showProgress({ text: `Opening ${title}…` });
        try {
            const answer = await fetch(desktopUrl('open'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: link.project, name: link.name }),
            });
            const body = await answer.json() as { path?: string; error?: string };
            if (!answer.ok || !body.path) {
                throw new Error(body.error ?? `HTTP ${answer.status}`);
            }
            await this.workspaces.open(URI.fromFilePath(body.path), { preserveWindow: true });
        } finally {
            progress.cancel();
        }
    }

    /** Connect to the Studio the link names: one this build offers without a
     *  question, any other only once the member says so. */
    protected async connect(link: DesktopLink, status: DesktopStatus): Promise<DesktopStatus> {
        if (!status.switchable) {
            throw new Error(`the link is for ${link.studioUrl ?? link.issuer}, and this run is pinned to ${status.current?.studioUrl ?? 'another Studio'}`);
        }
        const known = environmentFor(link, status.environments);
        let target: { id: string } | { studioUrl: string; issuer?: string };
        if (known) {
            target = { id: known.id };
        } else {
            if (!link.studioUrl) {
                throw new Error('the link names a Studio this build does not offer, and no address to reach it at');
            }
            const custom = customEnvironment(link.studioUrl, link.issuer);
            const ok = await new ConfirmDialog({
                title: 'Connect to another Studio?',
                msg: `The link opens a project on ${custom.label}, which this app is not set up for. Connect to it and sign in there?`,
                ok: 'Connect',
            }).open();
            if (!ok) {
                throw new Error('not connected');
            }
            target = { studioUrl: custom.studioUrl, issuer: custom.issuer };
        }
        const answer = await fetch(desktopUrl('environment'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(target),
        });
        if (!answer.ok) {
            throw new Error(((await answer.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${answer.status}`);
        }
        return answer.json() as Promise<DesktopStatus>;
    }

    /** Start the member's sign-in in the system browser and wait for it. */
    protected async signIn(): Promise<DesktopStatus> {
        await fetch(desktopUrl('sign-in'), { method: 'POST' });
        const progress = await this.messages.showProgress({ text: 'Sign in to Studio in the browser that just opened…' });
        try {
            const deadline = Date.now() + SIGN_IN_BUDGET_MS;
            while (Date.now() < deadline) {
                const status = await desktopStatus();
                if (status?.state === 'signed-in') {
                    return status;
                }
                if (status?.state === 'failed') {
                    throw new Error(status.error ?? 'sign-in failed');
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            throw new Error('sign-in took too long');
        } finally {
            progress.cancel();
        }
    }
}
