/**
 * @jest-environment node
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { PluginDeployerHandlerImpl } from '@theia/plugin-ext/lib/hosted/node/plugin-deployer-handler-impl';
import { DesktopPluginDeployerHandler, pendingRemovalsFile, readPendingRemovals, removeWithin, stopProcessesUnder } from './desktop-plugin-uninstall';

const ID = 'anthropic.claude-code@2.1.284' as const;

describe('desktop plugin uninstall', () => {
    let dir: string;
    const saved = { ...process.env };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-uninstall-'));
        process.env.STUDIO_DESKTOP_ENVIRONMENTS = '[]';
        process.env.STUDIO_DATA_DIR = path.join(dir, 'data');
    });

    afterEach(() => {
        process.env = { ...saved };
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** The handler with Theia's own uninstall stood in for, and its lookups of processes and folders controlled. */
    function handler(options: { removable: (folder: string) => boolean; stopped?: number[] }) {
        const theia = jest.spyOn(PluginDeployerHandlerImpl.prototype, 'uninstallPlugin').mockResolvedValue(true);
        const it = Object.create(DesktopPluginDeployerHandler.prototype) as DesktopPluginDeployerHandler;
        const plugin = path.join(dir, 'deployedPlugins', ID);
        const seenByTheia: string[][] = [];
        theia.mockImplementation(async function (this: DesktopPluginDeployerHandler) {
            seenByTheia.push([...(this as unknown as { sourceLocations: Map<string, Set<string>> }).sourceLocations.get(ID) ?? []]);
            return true;
        });
        Object.assign(it, {
            logger: { info: () => undefined, warn: () => undefined },
            sourceLocations: new Map([[ID, new Set([plugin])]]),
            stopProcessesUnder: jest.fn(async () => options.stopped ?? []),
            removeWithin: jest.fn(async (folder: string) => options.removable(folder)),
        });
        return { it, plugin, theia, seenByTheia };
    }

    const onWindows = process.platform === 'win32' ? it : it.skip;

    onWindows('stops what runs from the folder, removes it, then lets Theia mark it uninstalled', async () => {
        const { it: handlerUnderTest, plugin, theia, seenByTheia } = handler({ removable: () => true, stopped: [4242] });

        expect(await handlerUnderTest.uninstallPlugin(ID)).toBe(true);

        expect((handlerUnderTest as unknown as { stopProcessesUnder: jest.Mock }).stopProcessesUnder).toHaveBeenCalledWith(plugin);
        expect(theia).toHaveBeenCalledTimes(1);
        expect(seenByTheia).toEqual([[plugin]]);
        expect(readPendingRemovals(pendingRemovalsFile()!)).toEqual([]);
    });

    onWindows('leaves a folder still in use for the next start, and Theia marks it uninstalled without waiting on it', async () => {
        const { it: handlerUnderTest, plugin, seenByTheia } = handler({ removable: () => false });

        expect(await handlerUnderTest.uninstallPlugin(ID)).toBe(true);

        expect(seenByTheia).toEqual([[]]);
        expect(readPendingRemovals(pendingRemovalsFile()!)).toEqual([plugin]);
    });

    it('is Theia\'s uninstall as it was in a session, which names no Studios', async () => {
        delete process.env.STUDIO_DESKTOP_ENVIRONMENTS;
        const { it: handlerUnderTest, theia } = handler({ removable: () => false });

        await handlerUnderTest.uninstallPlugin(ID);

        expect((handlerUnderTest as unknown as { stopProcessesUnder: jest.Mock }).stopProcessesUnder).not.toHaveBeenCalled();
        expect(theia).toHaveBeenCalledTimes(1);
        expect(pendingRemovalsFile()).toBeUndefined();
    });

    onWindows('stops a process started from under the folder, and only that one', async () => {
        const folder = path.join(dir, 'plugin', 'bin');
        fs.mkdirSync(folder, { recursive: true });
        // A copy of this Node, as an extension ships its own executable (a
        // copied system binary is refused by Windows).
        const runner = path.join(folder, 'runner.exe');
        fs.copyFileSync(process.execPath, runner);
        const child = spawn(runner, ['-e', 'setTimeout(() => undefined, 60000)'], { stdio: 'ignore', windowsHide: true });
        const exited = new Promise(resolve => child.once('exit', resolve));

        const stopped = await stopProcessesUnder(path.join(dir, 'plugin'));

        expect(stopped).toEqual([child.pid]);
        await exited;
        expect(await removeWithin(path.join(dir, 'plugin'), 5_000)).toBe(true);
    }, 30_000);

    it('removes a folder nothing holds', async () => {
        const folder = path.join(dir, 'free');
        fs.mkdirSync(path.join(folder, 'extension'), { recursive: true });
        fs.writeFileSync(path.join(folder, 'extension', 'package.json'), '{}');

        expect(await removeWithin(folder, 5_000)).toBe(true);
        expect(fs.existsSync(folder)).toBe(false);
    });
});
