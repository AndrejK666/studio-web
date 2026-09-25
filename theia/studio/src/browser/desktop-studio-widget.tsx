// The desktop Studio's own view (ADR-0027): who is signed in, and what they can
// open. In a session the portal hands the IDE its token; on the desktop there
// is no portal, so this view is where the member signs in. The token never
// reaches it — the IDE backend holds it and attaches it on the way to Studio.

import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { Endpoint } from '@theia/core/lib/browser/endpoint';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { StudioApi } from './studio-api';
import { DesktopEnvironmentChoice } from '../common/desktop-environments';

export const DESKTOP_STUDIO_WIDGET_ID = 'studio.desktop';

export interface DesktopStatus extends DesktopEnvironmentChoice {
    enabled: boolean;
    studioUrl?: string;
    state: 'signed-out' | 'signing-in' | 'signed-in' | 'failed';
    error?: string;
    user?: { sub: string; name?: string; tenantId?: string };
    /** Which updates the app takes; absent from a backend that predates it. */
    updates?: 'stable' | 'beta';
}

interface Tenant {
    id: string;
    name: string;
    tenant_type?: string;
}

interface Organization extends Tenant {
    workspaces: Tenant[];
}

export function desktopUrl(path: string): string {
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
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    protected status: DesktopStatus | undefined;
    /** The workspace being cloned and opened, and how that went. */
    protected opening: string | undefined;
    protected openError = '';
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

    /** Whether the "which Studio" picker is open while signed in. */
    protected choosing = false;
    protected customUrl = '';
    protected switchError = '';

    /** Connect to another Studio: the backend signs out of this one first. */
    protected async switchTo(target: { id: string } | { studioUrl: string }): Promise<void> {
        this.switchError = '';
        const answer = await fetch(desktopUrl('environment'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(target),
        });
        if (!answer.ok) {
            this.switchError = ((await answer.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${answer.status}`;
            this.update();
            return;
        }
        this.choosing = false;
        this.organizations = undefined;
        this.loadError = '';
        this.openError = '';
        await this.refresh();
    }

    protected async signOut(): Promise<void> {
        await fetch(desktopUrl('sign-out'), { method: 'POST' });
        this.organizations = undefined;
        await this.refresh();
    }

    /** Which Studio this IDE connects to: the build's list, or an address. */
    protected renderPicker(status: DesktopStatus): React.ReactNode {
        if (!status.switchable) {
            return undefined;
        }
        const current = status.current;
        const value = current?.id === 'custom' ? 'custom' : current?.id ?? '';
        return <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', opacity: 0.8, marginBottom: '4px' }}>Studio</label>
            <select className='theia-select' style={{ width: '100%' }} value={value}
                onChange={e => e.target.value === 'custom'
                    ? (this.customUrl = current?.id === 'custom' ? current.studioUrl : '', this.choosing = true, this.update())
                    : void this.switchTo({ id: e.target.value })}>
                {status.environments.map(env => <option key={env.id} value={env.id}>{env.label} — {env.studioUrl.replace(/^https?:\/\//, '')}</option>)}
                <option value='custom'>{current?.id === 'custom' ? `Other — ${current.label}` : 'Other…'}</option>
            </select>
            {(this.choosing || current?.id === 'custom') && <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                <input className='theia-input' style={{ flex: 1 }} placeholder='https://studio.example.com'
                    value={this.customUrl} onChange={e => { this.customUrl = e.target.value; this.update(); }}
                    onKeyDown={e => e.key === 'Enter' && void this.switchTo({ studioUrl: this.customUrl })} />
                <button className='theia-button secondary' onClick={() => void this.switchTo({ studioUrl: this.customUrl })}>Use</button>
            </div>}
            {this.switchError && <p style={{ color: 'var(--theia-errorForeground)' }}>{this.switchError}</p>}
        </div>;
    }

    /** Take pre-releases of the app too, or only releases. */
    protected async setUpdates(beta: boolean): Promise<void> {
        const answer = await fetch(desktopUrl('updates'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: beta ? 'beta' : 'stable' }),
        });
        if (answer.ok) {
            this.status = await answer.json() as DesktopStatus;
            this.update();
        }
    }

    /** The app's own updates: checked on start, offered once downloaded. */
    protected renderUpdates(status: DesktopStatus): React.ReactNode {
        return <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '16px', fontSize: '12px', opacity: 0.85 }}
            title='Beta versions come out before a release, to try what is next. The app checks on start and offers each update once it has downloaded.'>
            <input type='checkbox' checked={status.updates === 'beta'} onChange={e => void this.setUpdates(e.target.checked)} />
            Get beta versions of the app
        </label>;
    }

    protected async signIn(): Promise<void> {
        await fetch(desktopUrl('sign-in'), { method: 'POST' });
        await this.refresh();
    }

    /** Clone the workspace's sources through Studio, then open the folder here. */
    protected async openWorkspace(workspace: Tenant): Promise<void> {
        this.opening = workspace.id;
        this.openError = '';
        this.update();
        try {
            const answer = await fetch(desktopUrl('open'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: workspace.id, name: workspace.name }),
            });
            const body = await answer.json() as { path?: string; error?: string };
            if (!answer.ok || !body.path) {
                throw new Error(body.error ?? `HTTP ${answer.status}`);
            }
            await this.workspaceService.open(URI.fromFilePath(body.path), { preserveWindow: true });
        } catch (error) {
            this.openError = `${workspace.name} could not be opened: ${error instanceof Error ? error.message : error}`;
        } finally {
            this.opening = undefined;
            this.update();
        }
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
            return <div style={box}>
                {status.switchable ? this.renderPicker(status) : header}
                <h3 style={{ margin: '0 0 8px' }}>Sign in to Constructor Studio</h3>
                <p>Your workspaces, their sources and the AI your organization provides are one sign-in away.
                    Nothing is stored on this computer but that sign-in.</p>
                {status.state === 'failed' && <p style={{ color: 'var(--theia-errorForeground)' }}>{status.error}</p>}
                <button className='theia-button' style={button} onClick={() => void this.signIn()}>
                    Sign in with Constructor ID
                </button>
                <p style={{ opacity: 0.7, marginTop: '8px' }}>Opens the sign-in page in your browser.</p>
                {this.renderUpdates(status)}
            </div>;
        }
        const link: React.CSSProperties = { cursor: 'pointer', marginRight: '12px' };
        return <div style={box}>
            {this.choosing ? this.renderPicker(status) : <div style={{ opacity: 0.7, fontSize: '0.9em', marginBottom: '12px' }}>
                {status.current?.label && status.current.id !== 'custom' && status.current.id !== 'pinned' ? `${status.current.label} · ` : ''}
                {status.studioUrl}
            </div>}
            <p><span className='codicon codicon-pass-filled' style={{ color: 'var(--theia-testing-iconPassed)' }} /> Signed in
                as <b>{status.user?.name ?? status.user?.sub}</b></p>
            <div style={{ fontSize: '0.9em' }}>
                {status.switchable && <a style={link} onClick={() => { this.choosing = !this.choosing; this.update(); }}>
                    {this.choosing ? 'Keep this Studio' : 'Switch Studio'}
                </a>}
                <a style={link} onClick={() => void this.signOut()}>Sign out</a>
            </div>
            {this.loadError && <p style={{ color: 'var(--theia-errorForeground)' }}>{this.loadError}</p>}
            {!this.organizations && !this.loadError && <p>Loading your workspaces…</p>}
            {this.organizations?.map(org => <div key={org.id} style={{ marginTop: '12px' }}>
                <div><span className='codicon codicon-organization' /> <b>{org.name}</b></div>
                {org.workspaces.length === 0 && <div style={{ paddingLeft: '20px', opacity: 0.7 }}>No workspaces yet</div>}
                {org.workspaces.map(ws => <div key={ws.id} style={{ paddingLeft: '20px', cursor: 'pointer' }}
                    title={`Open ${ws.name} here — its sources are cloned through Studio`}
                    onClick={() => this.opening || void this.openWorkspace(ws)}>
                    <span className={this.opening === ws.id ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-folder'} />
                    {' '}<a>{ws.name}</a>
                </div>)}
            </div>)}
            {this.openError && <p style={{ color: 'var(--theia-errorForeground)' }}>{this.openError}</p>}
            {this.renderUpdates(status)}
        </div>;
    }
}
