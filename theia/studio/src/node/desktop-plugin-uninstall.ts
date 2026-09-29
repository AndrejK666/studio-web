import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import { PluginDeployerHandlerImpl } from '@theia/plugin-ext/lib/hosted/node/plugin-deployer-handler-impl';
import { PluginIdentifiers } from '@theia/plugin-ext/lib/common/plugin-protocol';

/** How long one plugin folder may take to go before it is left for the next start. */
const REMOVE_WITHIN_MS = 15_000;

/**
 * The file desktop-main.js reads before the IDE starts: folders an uninstall
 * could not remove because something still held them. Beside the app's own
 * data (`STUDIO_DATA_DIR`), so it is the desktop's, never a session's.
 */
export function pendingRemovalsFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
    // A desktop names its Studios (desktop-main.js); a session never does.
    const desktop = !!(env.STUDIO_DESKTOP_ENVIRONMENTS?.trim() || env.STUDIO_DESKTOP_URL?.trim());
    const data = env.STUDIO_DATA_DIR?.trim();
    return desktop && data ? path.join(data, 'pending-plugin-removals.json') : undefined;
}

export function readPendingRemovals(file: string): string[] {
    try {
        const list = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
        return [];
    }
}

export function addPendingRemovals(file: string, folders: readonly string[]): void {
    const all = new Set([...readPendingRemovals(file), ...folders]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...all], undefined, 2) + '\n');
}

/**
 * Uninstalling an extension from the Extensions view on a Windows desktop.
 *
 * Theia's own uninstall deletes the extension's folder and only then marks it
 * uninstalled. On Windows a folder cannot go while something runs from it:
 * Claude Code starts its `claude.exe` from its folder, and loads a native
 * module (`resources/audio-capture`) into the plugin host itself. The delete
 * then never finishes, the view stays at "Uninstalling", nothing is marked,
 * and the extension is back on the next start.
 *
 * So, before Theia's uninstall runs: the processes started from the folder are
 * stopped, and the folder is removed within a bound. What still cannot go (a
 * module loaded into this very plugin host) is left out of Theia's delete and
 * recorded; desktop-main.js removes it on the next start, before any plugin
 * loads. Theia then marks the extension uninstalled and the view offers
 * "Reload Window", as for any extension.
 *
 * An extension of Theia's handler, bound in its place: its own steps
 * (localizations, the uninstall mark) run unchanged. Anywhere but a Windows
 * desktop it is Theia's uninstall as it was.
 */
@injectable()
export class DesktopPluginDeployerHandler extends PluginDeployerHandlerImpl {
    override async uninstallPlugin(pluginId: PluginIdentifiers.VersionedId): Promise<boolean> {
        const pending = pendingRemovalsFile();
        const locations = this.sourceLocations.get(pluginId);
        if (process.platform !== 'win32' || !pending || !locations) {
            return super.uninstallPlugin(pluginId);
        }
        const stuck: string[] = [];
        for (const location of locations) {
            const stopped = await this.stopProcessesUnder(location);
            if (stopped.length) {
                this.logger.info(`[studio-desktop] ${pluginId}: stopped ${stopped.length} process(es) running from ${location}`);
            }
            if (!await this.removeWithin(location, REMOVE_WITHIN_MS)) {
                stuck.push(location);
            }
        }
        if (stuck.length) {
            addPendingRemovals(pending, stuck);
            this.logger.warn(`[studio-desktop] ${pluginId}: ${stuck.join(', ')} is still in use; removed on the next start`);
            // Theia's delete would wait on the same lock: it gets what is left.
            this.sourceLocations.set(pluginId, new Set([...locations].filter(location => !stuck.includes(location))));
        }
        return super.uninstallPlugin(pluginId);
    }

    protected stopProcessesUnder(folder: string): Promise<number[]> {
        return stopProcessesUnder(folder);
    }

    protected removeWithin(folder: string, ms: number): Promise<boolean> {
        return removeWithin(folder, ms);
    }
}

/** Removes a folder, giving up (false) when it is still there after `ms`. */
export async function removeWithin(folder: string, ms: number): Promise<boolean> {
    const removal = fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        .then(() => true, () => false);
    const timeout = new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms).unref());
    return (await Promise.race([removal, timeout])) && !fs.existsSync(folder);
}

/**
 * Stops every process whose executable lives under `folder` and answers their
 * ids. Windows only; the folder goes to PowerShell through the environment,
 * never through the command text.
 */
export function stopProcessesUnder(folder: string): Promise<number[]> {
    if (process.platform !== 'win32') {
        return Promise.resolve([]);
    }
    const script = [
        "$root = $env:STUDIO_PLUGIN_FOLDER.TrimEnd('\\') + '\\'",
        'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {',
        '  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId',
        '}',
    ].join('\n');
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            env: { ...process.env, STUDIO_PLUGIN_FOLDER: folder },
            timeout: 20_000,
            windowsHide: true,
        }, (error, stdout) => {
            resolve(error ? [] : String(stdout).split(/\r?\n/).map(line => Number(line.trim())).filter(id => Number.isInteger(id) && id > 0));
        });
    });
}
