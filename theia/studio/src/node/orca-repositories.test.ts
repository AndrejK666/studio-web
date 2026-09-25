import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitRepositoriesAt } from './orca-service';

describe('the repositories a workspace hands to Orca', () => {
    let root: string;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-repos-'));
    });
    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
    const repo = (dir: string, gitFile = false) => {
        fs.mkdirSync(dir, { recursive: true });
        if (gitFile) {
            fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /somewhere/else\n');
        } else {
            fs.mkdirSync(path.join(dir, '.git'));
        }
    };

    it('takes the root itself when it is a repository', async () => {
        repo(root);
        repo(path.join(root, 'nested'));
        expect(await gitRepositoriesAt(root)).toEqual([root]);
    });

    it('takes each checkout one level down when the root is a plain folder, as a session lays them out', async () => {
        repo(path.join(root, 'studio-web'));
        repo(path.join(root, 'gears-rust'));
        fs.mkdirSync(path.join(root, 'notes'));
        repo(path.join(root, '.hidden'));
        repo(path.join(root, 'node_modules'));
        expect(await gitRepositoriesAt(root)).toEqual([path.join(root, 'gears-rust'), path.join(root, 'studio-web')]);
    });

    it('knows a linked worktree, whose .git is a file', async () => {
        repo(path.join(root, 'feature'), true);
        expect(await gitRepositoriesAt(root)).toEqual([path.join(root, 'feature')]);
    });

    it('answers nothing for a folder that is not there', async () => {
        expect(await gitRepositoriesAt(path.join(root, 'missing'))).toEqual([]);
    });
});
