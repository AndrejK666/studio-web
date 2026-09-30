import 'reflect-metadata';
import URI from '@theia/core/lib/common/uri';
import { openProjectInPlace, projectWorkspaceFile, type ProjectWorkspace } from './desktop-open-project';

function workspace(opts: { current?: { uri: string; dir: boolean }; roots?: string[] }) {
    let roots = (opts.roots ?? []).map(r => ({ resource: new URI(r) }));
    let current = opts.current && { resource: new URI(opts.current.uri), isDirectory: opts.current.dir };
    const calls: string[] = [];
    const ws = {
        get workspace() { return current; },
        tryGetRoots: () => roots,
        save: jest.fn(async (uri: URI) => { calls.push(`save ${uri.path.base}`); current = { resource: uri, isDirectory: false }; }),
        spliceRoots: jest.fn(async (start: number, del: number, ...add: URI[]) => {
            calls.push(`splice ${start} ${del} ${add.map(u => u.path.base).join(',')}`);
            roots = [...roots.slice(0, start), ...add.map(resource => ({ resource })), ...roots.slice(start + del)];
            return [];
        }),
    };
    return { ws: ws as unknown as ProjectWorkspace, calls };
}

describe('opening a project on the desktop', () => {
    const project = new URI('file:///home/m/ConstructorStudio/workspaces/Shop');

    it('names the workspace file after the project, beside its folder', () => {
        expect(projectWorkspaceFile(project).toString()).toBe('file:///home/m/ConstructorStudio/workspaces/Shop.theia-workspace');
    });

    it('turns the placeholder folder into the project\'s workspace file, then swaps the folders — no open, no reload', async () => {
        const { ws, calls } = workspace({ current: { uri: 'file:///home/m/ConstructorStudio/workspace', dir: true }, roots: ['file:///home/m/ConstructorStudio/workspace'] });
        await openProjectInPlace(ws, project);
        expect(calls).toEqual(['save Shop.theia-workspace', 'splice 0 1 Shop']);
        expect(ws.tryGetRoots().map(r => r.resource.toString())).toEqual([project.toString()]);
    });

    it('moves from one project to another the same way', async () => {
        const { ws, calls } = workspace({
            current: { uri: 'file:///home/m/ConstructorStudio/workspaces/Blog.theia-workspace', dir: false },
            roots: ['file:///home/m/ConstructorStudio/workspaces/Blog'],
        });
        await openProjectInPlace(ws, project);
        expect(calls).toEqual(['save Shop.theia-workspace', 'splice 0 1 Shop']);
    });

    it('does nothing for the project already open', async () => {
        const { ws, calls } = workspace({
            current: { uri: projectWorkspaceFile(project).toString(), dir: false },
            roots: [project.toString()],
        });
        await openProjectInPlace(ws, project);
        expect(calls).toEqual([]);
    });
});
