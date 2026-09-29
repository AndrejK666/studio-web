import * as fs from 'fs';
import * as path from 'path';
import type { AssistantStatus, OpenVsxAssistant } from '../common/desktop-assistants';

/** What the bootstrap needs of Theia's plugin server. */
export interface OpenVsxInstaller {
    /** `id@version` of every extension installed now, whoever installed it. */
    installed(): Promise<readonly string[]>;
    /** Installs the newest version open-vsx has, as the member's own extension. */
    install(id: string): Promise<void>;
}

export interface OpenVsxBootstrapOptions {
    readonly assistants: readonly OpenVsxAssistant[];
    readonly installer: OpenVsxInstaller;
    /** Where the ids installed once are remembered, so a removed one stays removed. */
    readonly markerFile: string;
    /** The plugins directory an older build's pinned copies were unpacked into. */
    readonly pluginsDir: string;
    readonly log?: (line: string) => void;
}

interface Entry {
    status: AssistantStatus;
    running?: Promise<void>;
}

/**
 * Claude Code and Codex on a desktop: installed from open-vsx the first time
 * the app starts, at the version open-vsx has then, exactly as the Extensions
 * view installs them (`vscode-extension://<id>`, a user extension). From then
 * on they are the member's: the view updates or removes them, and one the
 * member removed is not installed again.
 *
 * An older build pinned them and unpacked each into the plugins directory as a
 * system extension; those copies are removed once the member's own is there,
 * so one id has one owner (two copies of one id: Theia silently runs one).
 */
export class OpenVsxBootstrap {
    protected readonly entries = new Map<string, Entry>();
    protected readonly log: (line: string) => void;

    constructor(protected readonly options: OpenVsxBootstrapOptions) {
        this.log = options.log ?? (line => console.info(`[studio-desktop] ${line}`));
        for (const assistant of options.assistants) {
            this.entries.set(assistant.id, {
                status: { id: assistant.id, label: assistant.label, version: 'latest', state: 'missing' }
            });
        }
    }

    /** What each one is doing; one the member removed is not listed. */
    status(): AssistantStatus[] {
        const removed = this.remembered();
        return this.options.assistants
            .map(a => this.entries.get(a.id)!.status)
            .filter(s => !(removed.has(s.id) && s.state === 'missing'));
    }

    /** Installs what was never installed, one at a time. Safe to call again while it runs. */
    async ensure(): Promise<void> {
        const installed = await this.installedVersions();
        const remembered = this.remembered();
        for (const assistant of this.options.assistants) {
            const entry = this.entries.get(assistant.id)!;
            const version = installed.get(assistant.id);
            if (version) {
                entry.status = { ...entry.status, version, state: 'ready', error: undefined };
                this.remember(assistant.id);
                this.removePinnedCopies(assistant.id);
                continue;
            }
            if (remembered.has(assistant.id) || entry.status.state === 'failed') {
                continue;
            }
            entry.running ??= this.install(assistant, entry).finally(() => { entry.running = undefined; });
            await entry.running;
        }
    }

    /** Tries a failed one again (or all of them). */
    async retry(id?: string): Promise<void> {
        for (const entry of this.entries.values()) {
            if ((!id || id === entry.status.id) && entry.status.state === 'failed') {
                entry.status = { ...entry.status, state: 'missing', error: undefined };
            }
        }
        await this.ensure();
    }

    protected async install(assistant: OpenVsxAssistant, entry: Entry): Promise<void> {
        entry.status = { ...entry.status, state: 'installing', error: undefined };
        this.log(`${assistant.label}: installing the newest version from open-vsx`);
        try {
            await this.options.installer.install(assistant.id);
            const version = (await this.installedVersions()).get(assistant.id) ?? 'latest';
            entry.status = { ...entry.status, version, state: 'ready' };
            this.remember(assistant.id);
            this.removePinnedCopies(assistant.id);
            this.log(`${assistant.label} ${version}: installed`);
        } catch (error) {
            const cause = error instanceof Error ? error.message : String(error);
            entry.status = {
                ...entry.status,
                state: 'failed',
                error: `open-vsx.org could not provide it (${cause}). Check the connection and try again, or install it from the Extensions view`
            };
            this.log(`${assistant.label}: failed: ${cause}`);
        }
    }

    protected async installedVersions(): Promise<Map<string, string>> {
        const versions = new Map<string, string>();
        for (const versioned of await this.options.installer.installed()) {
            const at = versioned.lastIndexOf('@');
            if (at > 0) {
                versions.set(versioned.slice(0, at).toLowerCase(), versioned.slice(at + 1));
            }
        }
        return versions;
    }

    protected remembered(): Set<string> {
        try {
            const ids = JSON.parse(fs.readFileSync(this.options.markerFile, 'utf8'));
            return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
        } catch {
            return new Set();
        }
    }

    protected remember(id: string): void {
        const ids = this.remembered();
        if (ids.has(id)) {
            return;
        }
        ids.add(id);
        try {
            fs.mkdirSync(path.dirname(this.options.markerFile), { recursive: true });
            fs.writeFileSync(this.options.markerFile, JSON.stringify([...ids].sort(), undefined, 2) + '\n');
        } catch (error) {
            this.log(`cannot remember ${id} as installed (${error}); a removed ${id} may come back`);
        }
    }

    /** `<pluginsDir>/<id>-<version>/`: what a pinning build unpacked. */
    protected removePinnedCopies(id: string): void {
        let names: string[];
        try {
            names = fs.readdirSync(this.options.pluginsDir);
        } catch {
            return;
        }
        for (const name of names) {
            if (name.startsWith(`${id}-`) && /^\d/.test(name.slice(id.length + 1))) {
                this.log(`removing ${name}: ${id} is now installed from open-vsx`);
                fs.rmSync(path.join(this.options.pluginsDir, name), { recursive: true, force: true });
            }
        }
    }
}
