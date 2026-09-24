// The desktop Studio's own view (ADR-0027): who is signed in, and what they can
// open. In a session the portal hands the IDE its token; on the desktop there
// is no portal, so this view is where the member signs in. The token never
// reaches it — the IDE backend holds it and attaches it on the way to Studio.

import * as React from '@theia/core/shared/react';
import { injectable } from '@theia/core/shared/inversify';
import { Endpoint } from '@theia/core/lib/browser/endpoint';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { StudioApi } from './studio-api';

export const DESKTOP_STUDIO_WIDGET_ID = 'studio.desktop';

interface DesktopStatus {
    enabled: boolean;
    studioUrl?: string;
    state: 'signed-out' | 'signing-in' | 'signed-in' | 'failed';
    error?: string;
    user?: { sub: string; name?: string; tenantId?: string };
}

interface Tenant {
    id: string;
    name: string;
    tenant_type?: string;
}

interface Organization extends Tenant {
    workspaces: Tenant[];
}

function desktopUrl(path: string): string {
    return new Endpoint({ path: `studio-desktop/${path}` }).getRestUrl().toString();
}

export async function desktopStatus(): Promise<DesktopStatus | undefined> {
    try {
        const answer = await fetch(desktopUrl('status'));
        return answer.ok ? await answer.json() as DesktopStatus : undefined;
    } catch {
        return undefined;
    }
}

const kind = (tenant: Tenant): string => tenant.tenant_type?.match(/cf\.studio\.tenant\.(\w+)\.v1/)?.[1] ?? 'tenant';

@injectable()
export class DesktopStudioWidget extends ReactWidget {
    protected status: DesktopStatus | undefined;
    protected organizations: Organization[] | undefined;
    protected loadError = '';
    protected poll: number | undefined;

    constructor() {
        super();
        this.id = DESKTOP_STUDIO_WIDGET_ID;
        this.title.label = 'Constructor Studio';
        this.title.caption = 'Your Constructor Studio account and workspaces';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-account';
        this.addClass('studio-desktop-view');
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        void this.refresh();
    }

    protected onBeforeDetach(msg: Message): void {
        window.clearInterval(this.poll);
        super.onBeforeDetach(msg);
    }

    protected async refresh(): Promise<void> {
        const before = this.status?.state;
        this.status = await desktopStatus();
        if (this.status?.state === 'signing-in') {
            this.poll ??= window.setInterval(() => void this.refresh(), 1000);
        } else {
            window.clearInterval(this.poll);
            this.poll = undefined;
        }
        if (this.status?.state === 'signed-in' && before !== 'signed-in') {
            await this.loadEntities();
        }
        this.update();
    }

    protected async signIn(): Promise<void> {
        await fetch(desktopUrl('sign-in'), { method: 'POST' });
        await this.refresh();
    }

    /** The member's organizations and their workspaces, as the portal lists them. */
    protected async loadEntities(): Promise<void> {
        const home = this.status?.user?.tenantId;
        if (!home) {
            return;
        }
        try {
            const children = async (id: string): Promise<Tenant[]> => {
                const answer = await StudioApi.fetch(`/account-management/v1/tenants/${id}/children`);
                if (!answer.ok) {
                    throw new Error(`HTTP ${answer.status}`);
                }
                return ((await answer.json()).items ?? []) as Tenant[];
            };
            const organizations = (await children(home)).filter(t => kind(t) === 'organization');
            this.organizations = await Promise.all(organizations.map(async org => ({
                ...org,
                workspaces: (await children(org.id)).filter(t => kind(t) === 'workspace'),
            })));
            this.loadError = '';
        } catch (error) {
            this.loadError = `Your workspaces could not be loaded (${error instanceof Error ? error.message : error}).`;
        }
    }

    protected render(): React.ReactNode {
        const status = this.status;
        const box: React.CSSProperties = { padding: '16px', lineHeight: 1.5 };
        const button: React.CSSProperties = { marginTop: '12px', width: '100%' };
        if (!status) {
            return <div style={box}>Checking your Studio sign-in…</div>;
        }
        if (!status.enabled) {
            return <div style={box}>This IDE is not connected to a Constructor Studio.</div>;
        }
        const header = <div style={{ opacity: 0.7, fontSize: '0.9em', marginBottom: '12px' }}>{status.studioUrl}</div>;
        if (status.state === 'signing-in') {
            return <div style={box}>{header}
                <p><span className='codicon codicon-loading codicon-modifier-spin' /> Finish signing in in your browser.</p>
                <p style={{ opacity: 0.7 }}>Studio opened the sign-in page there; this view updates once you are done.</p>
            </div>;
        }
        if (status.state !== 'signed-in') {
            return <div style={box}>{header}
                <h3 style={{ margin: '0 0 8px' }}>Sign in to Constructor Studio</h3>
                <p>Your workspaces, their sources and the AI your organization provides are one sign-in away.
                    Nothing is stored on this computer but that sign-in.</p>
                {status.state === 'failed' && <p style={{ color: 'var(--theia-errorForeground)' }}>{status.error}</p>}
                <button className='theia-button' style={button} onClick={() => void this.signIn()}>
                    Sign in with Constructor ID
                </button>
                <p style={{ opacity: 0.7, marginTop: '8px' }}>Opens the sign-in page in your browser.</p>
            </div>;
        }
        return <div style={box}>{header}
            <p><span className='codicon codicon-pass-filled' style={{ color: 'var(--theia-testing-iconPassed)' }} /> Signed in
                as <b>{status.user?.name ?? status.user?.sub}</b></p>
            {this.loadError && <p style={{ color: 'var(--theia-errorForeground)' }}>{this.loadError}</p>}
            {!this.organizations && !this.loadError && <p>Loading your workspaces…</p>}
            {this.organizations?.map(org => <div key={org.id} style={{ marginTop: '12px' }}>
                <div><span className='codicon codicon-organization' /> <b>{org.name}</b></div>
                {org.workspaces.length === 0 && <div style={{ paddingLeft: '20px', opacity: 0.7 }}>No workspaces yet</div>}
                {org.workspaces.map(ws => <div key={ws.id} style={{ paddingLeft: '20px' }} title={ws.id}>
                    <span className='codicon codicon-folder' /> {ws.name}
                </div>)}
            </div>)}
        </div>;
    }
}
