import 'reflect-metadata';
import URI from '@theia/core/lib/common/uri';
import { StudioWorkspaceName } from './studio-workspace-name';

/** A file-tree node, as the Projects panel hands one to a label provider. */
function node(uri: string) {
    return { uri: new URI(uri), fileStat: { resource: new URI(uri), isDirectory: true } };
}

describe('what the session is called', () => {
    it('says nothing until the portal says something', () => {
        // No name yet is not the same as the name being "workspace": answering
        // 0 leaves the file label provider to give the directory's own name.
        const names = new StudioWorkspaceName();
        expect(names.canHandle(node('file:///workspace'))).toBe(0);
        expect(names.getName()).toBeUndefined();
    });

    it('names the root after the project once the portal says so', () => {
        const names = new StudioWorkspaceName();
        names.setName('Studioweb');
        // Above StudioFileTreeLabelProvider's 101, which would otherwise answer
        // with the directory's name.
        expect(names.canHandle(node('file:///workspace'))).toBeGreaterThan(101);
        expect(names.getName()).toBe('Studioweb');
    });

    it('renames the root only — every file below it keeps its filename', () => {
        const names = new StudioWorkspaceName();
        names.setName('Studioweb');
        expect(names.canHandle(node('file:///workspace/studio-web'))).toBe(0);
        expect(names.canHandle(node('file:///workspace/README.md'))).toBe(0);
    });

    it('redraws what was already drawn with the old name', () => {
        const names = new StudioWorkspaceName();
        const changes: unknown[] = [];
        names.onDidChange(event => changes.push(event));
        names.setName('Studioweb');
        expect(changes).toHaveLength(1);
        // The same name again is not a change; firing would redraw the tree for
        // nothing on every token renewal, which re-sends the handshake fields.
        names.setName('Studioweb');
        expect(changes).toHaveLength(1);
    });

    it('treats an empty name as no name', () => {
        const names = new StudioWorkspaceName();
        names.setName('   ');
        expect(names.getName()).toBeUndefined();
        expect(names.canHandle(node('file:///workspace'))).toBe(0);
    });
});
