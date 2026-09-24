import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as express from '@theia/core/shared/express';
import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { DesktopSession, signIn } from './desktop-sign-in';
import { CREDENTIALS_ENV, TokenBroker, startTokenBroker } from './desktop-token-broker';

/**
 * The desktop Studio (ADR-0027): what turns `electron-app` from an editor into
 * a session of the Studio it was pointed at.
 *
 * Off unless `STUDIO_DESKTOP_URL` names a Studio. With it, the backend signs the
 * member in, keeps their token in memory, and serves it three ways without
 * writing it down: to `git` through the token broker, to the IDE's own widgets
 * through a `/studio-api` proxy that attaches it here, and to nothing else.
 */
export interface DesktopStudioConfig {
    /** The Studio's public address, e.g. `https://studio.example.com`. */
    readonly studioUrl: string;
    /** Where the gateway mounts the gears under that address. */
    readonly gatewayPrefix: string;
    readonly issuer: string;
    readonly clientId: string;
    /** The workspace to open; its sources are cloned when absent. */
    readonly workspaceId?: string;
    readonly workspaceRoot: string;
    /** A command to open the sign-in page with, instead of the system browser. */
    readonly browserCommand?: string;
}

export function desktopConfigFrom(env: NodeJS.ProcessEnv, cwd: string): DesktopStudioConfig | undefined {
    const studioUrl = env.STUDIO_DESKTOP_URL?.trim().replace(/\/+$/, '');
    if (!studioUrl) {
        return undefined;
    }
    return {
        studioUrl,
        gatewayPrefix: (env.STUDIO_DESKTOP_GATEWAY_PREFIX ?? '/cf').replace(/\/+$/, ''),
        issuer: env.STUDIO_DESKTOP_ISSUER?.trim() || `${studioUrl}/realms/studio`,
        clientId: env.STUDIO_DESKTOP_CLIENT_ID?.trim() || 'studio-desktop',
        workspaceId: env.STUDIO_DESKTOP_WORKSPACE_ID?.trim() || undefined,
        workspaceRoot: env.STUDIO_WORKSPACE_ROOT?.trim() || cwd,
        browserCommand: env.STUDIO_DESKTOP_BROWSER?.trim() || undefined,
    };
}

/** The system browser, the way each platform spells it. */
function openInBrowser(url: string, command?: string): void {
    const [file, args] = command
        ? [command, [url]]
        : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
            : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(file, args, { detached: true, stdio: 'ignore' }).unref();
}

export const DESKTOP_GIT_HELPER = path.join(__dirname, '..', '..', 'scripts', 'desktop-git-credentials.mjs');

/** What the IDE's Studio view shows; never a token. */
export interface DesktopStatus {
    readonly enabled: boolean;
    readonly studioUrl?: string;
    readonly state: 'signed-out' | 'signing-in' | 'signed-in' | 'failed';
    readonly error?: string;
    readonly user?: { readonly sub: string; readonly name?: string; readonly tenantId?: string };
}

function claimsOf(accessToken: string): Record<string, unknown> {
    try {
        return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString('utf8'));
    } catch {
        return {};
    }
}

interface SourceDto {
    readonly name: string;
    readonly clone_path: string;
    readonly branch?: string;
    readonly target?: string;
}

@injectable()
export class DesktopStudioContribution implements BackendApplicationContribution {
    protected readonly config = desktopConfigFrom(process.env, process.cwd());
    protected session: DesktopSession | undefined;
    protected broker: TokenBroker | undefined;
    protected ready: Promise<void> | undefined;
    protected status: DesktopStatus = { enabled: !!this.config, studioUrl: this.config?.studioUrl, state: 'signed-out' };

    configure(app: express.Application): void {
        const config = this.config;
        if (!config) {
            return;
        }
        app.get('/studio-desktop/status', (_req, res) => { res.json(this.status); });
        app.post('/studio-desktop/sign-in', (_req, res) => {
            if (this.status.state !== 'signing-in' && this.status.state !== 'signed-in') {
                this.ready = this.start(config);
            }
            res.status(202).json(this.status);
        });
        // The widgets call `studio-api/<gear path>` as they do inside a session,
        // where the session gate forwards it. Here the backend is the gate.
        app.use('/studio-api', async (req, res) => {
            try {
                await this.ready;
                if (!this.session) {
                    res.status(503).json({ error: 'not signed in to Constructor Studio' });
                    return;
                }
                const target = `${config.studioUrl}${config.gatewayPrefix}${req.url}`;
                const hasBody = !['GET', 'HEAD'].includes(req.method);
                const answer = await fetch(target, {
                    method: req.method,
                    headers: {
                        Authorization: `Bearer ${await this.session.accessToken()}`,
                        ...(req.headers['content-type'] ? { 'Content-Type': String(req.headers['content-type']) } : {}),
                        ...(req.headers.accept ? { Accept: String(req.headers.accept) } : {}),
                    },
                    body: hasBody ? (req as unknown as ReadableStream) : undefined,
                    // Node's fetch needs this to stream a request body.
                    ...(hasBody ? { duplex: 'half' } : {}),
                } as RequestInit);
                res.status(answer.status);
                const type = answer.headers.get('content-type');
                if (type) {
                    res.setHeader('Content-Type', type);
                }
                res.end(Buffer.from(await answer.arrayBuffer()));
            } catch (error) {
                res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
            }
        });
    }

    onStart(): void {
        // Signing in is the person's move, from the Studio view — except where
        // a deployment asks for it at launch.
        if (this.config && process.env.STUDIO_DESKTOP_AUTO_SIGN_IN === '1') {
            this.ready = this.start(this.config);
        }
    }

    onStop(): void {
        this.broker?.close();
    }

    protected async start(config: DesktopStudioConfig): Promise<void> {
        this.status = { ...this.status, state: 'signing-in', error: undefined };
        try {
            await this.signInAndPrepare(config);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[studio-desktop] ${message}`);
            this.status = { ...this.status, state: this.session ? 'signed-in' : 'failed', error: message };
        }
    }

    protected async signInAndPrepare(config: DesktopStudioConfig): Promise<void> {
        const tokens = await signIn({
            issuer: config.issuer,
            clientId: config.clientId,
            openBrowser: url => {
                console.info(`[studio-desktop] sign in at ${url}`);
                openInBrowser(url, config.browserCommand);
            },
        });
        this.session = new DesktopSession(config.issuer, config.clientId, tokens);
        const session = this.session;
        this.broker = await startTokenBroker(new URL(config.studioUrl).host, () => session.accessToken());
        // Inherited by the plugin host, vscode.git, terminals and agents.
        process.env[CREDENTIALS_ENV] = this.broker.address;
        const claims = claimsOf(tokens.accessToken);
        this.status = {
            ...this.status,
            state: 'signed-in',
            user: {
                sub: String(claims.sub ?? ''),
                name: typeof claims.name === 'string' ? claims.name
                    : typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined,
                tenantId: typeof claims.tenant_id === 'string' ? claims.tenant_id : undefined,
            },
        };
        console.info(`[studio-desktop] signed in as ${this.status.user?.name ?? this.status.user?.sub}`);
        if (config.workspaceId) {
            await this.cloneSources(config, config.workspaceId);
        }
    }

    /** Clone every source of the workspace that is not on disk yet. */
    protected async cloneSources(config: DesktopStudioConfig, workspaceId: string): Promise<void> {
        const answer = await fetch(
            `${config.studioUrl}${config.gatewayPrefix}/studio-git/v1/sources?project_id=${encodeURIComponent(workspaceId)}`,
            { headers: { Authorization: `Bearer ${await this.session!.accessToken()}` } }
        );
        if (!answer.ok) {
            throw new Error(`the workspace's sources could not be listed (HTTP ${answer.status})`);
        }
        const { items } = await answer.json() as { items: SourceDto[] };
        for (const source of items) {
            const dir = path.resolve(config.workspaceRoot, source.target ?? source.name);
            if (fs.existsSync(path.join(dir, '.git'))) {
                continue;
            }
            const url = `${config.studioUrl}${config.gatewayPrefix}${source.clone_path}`;
            // `-c` on clone is written into the new repository's config: what
            // lands there is the helper's path, never a token.
            const helper = `!node "${DESKTOP_GIT_HELPER.replace(/\\/g, '/')}"`;
            const args = ['clone', '-c', 'credential.helper=', '-c', `credential.helper=${helper}`];
            if (source.branch) {
                args.push('--branch', source.branch);
            }
            args.push(url, dir);
            await new Promise<void>((resolve, reject) =>
                execFile('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, _out, stderr) =>
                    error ? reject(new Error(`cloning ${source.name} failed: ${stderr.trim()}`)) : resolve()));
            console.info(`[studio-desktop] cloned ${source.name} into ${dir}`);
        }
    }
}
