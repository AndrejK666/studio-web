import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RepositoryRegistry } from './repository-registry';

describe('repository registry', () => {
    let tempDir: string;
    let workspaceRoot: string;
    let rootRepository: string;
    let nestedRepository: string;
    let nestedFile: string;
    let registry: RepositoryRegistry;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-repository-registry-'));
        workspaceRoot = path.join(tempDir, 'workspace');
        rootRepository = workspaceRoot;
        nestedRepository = path.join(workspaceRoot, 'sources', 'nested');
        nestedFile = path.join(nestedRepository, 'README.md');
        await fs.mkdir(nestedRepository, { recursive: true });
        await fs.writeFile(nestedFile, '# Nested');
        registry = new RepositoryRegistry();
        await registry.initialize(workspaceRoot);
    });

    afterEach(async () => {
        registry.dispose();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('selects the deepest repository root that owns a file', async () => {
        await registry.replace([
            { repositoryRoot: rootRepository },
            { repositoryRoot: nestedRepository }
        ]);

        const owner = await registry.resolveOwner(nestedFile);

        expect(owner.canonicalRoot).toBe(await fs.realpath(nestedRepository));
        expect(owner.descriptor.workspaceRelativeRoot).toBe('sources/nested');
    });

    it('resolves the project repository by identity rather than list position', async () => {
        await registry.replace([
            { repositoryRoot: rootRepository },
            { repositoryRoot: nestedRepository }
        ]);

        // Deepest-first ordering puts the nested checkout at [0]. The project
        // repository is the configured root, so anything that reaches for the
        // head of the list gets a source clone instead -- which is how a kit
        // ends up installed in the wrong tree.
        expect(registry.repositories[0].canonicalRoot).toBe(await fs.realpath(nestedRepository));
        expect(registry.configuredRepository?.canonicalRoot).toBe(await fs.realpath(rootRepository));
    });

    it('reports no project repository until the configured root is registered', async () => {
        await registry.replace([{ repositoryRoot: nestedRepository }]);

        expect(registry.configuredRepository).toBeUndefined();
    });

    it('calls the only checkout the project when the workspace root is a plain directory', async () => {
        // A managed workspace is a container: /workspace holds the manifest and
        // one repository per source, and is not a repository itself. With a
        // single source there is nothing to disambiguate, so project-level
        // operations still have a target and the portal still has something to
        // preselect.
        await registry.replace([{ repositoryRoot: nestedRepository }]);

        expect(registry.projectRepository?.canonicalRoot).toBe(await fs.realpath(nestedRepository));
    });

    it('refuses to guess the project repository among several sources', async () => {
        const secondSource = path.join(workspaceRoot, 'sources', 'second');
        await fs.mkdir(secondSource, { recursive: true });
        await registry.replace([
            { repositoryRoot: nestedRepository },
            { repositoryRoot: secondSource }
        ]);

        expect(registry.projectRepository).toBeUndefined();
    });

    it('selects the workspace-root repository for files outside nested repositories', async () => {
        const rootFile = path.join(workspaceRoot, 'README.md');
        await fs.writeFile(rootFile, '# Root');
        await registry.replace([
            { repositoryRoot: rootRepository },
            { repositoryRoot: nestedRepository }
        ]);

        await expect(registry.resolveOwner(rootFile)).resolves.toMatchObject({
            canonicalRoot: await fs.realpath(rootRepository)
        });
    });

    it('rejects repository working trees outside the workspace', async () => {
        const outsideRepository = path.join(tempDir, 'outside');
        await fs.mkdir(outsideRepository);

        await expect(registry.replace([
            { repositoryRoot: outsideRepository }
        ])).rejects.toThrow('inside the configured workspace or be its configured containing repository');
    });

    it('registers the configured repository that contains a nested workspace', async () => {
        const containingRepository = path.join(tempDir, 'containing-repository');
        const nestedWorkspace = path.join(containingRepository, 'docs');
        const workspaceFile = path.join(nestedWorkspace, 'README.md');
        await fs.mkdir(nestedWorkspace, { recursive: true });
        await fs.writeFile(workspaceFile, '# Nested workspace');
        registry.dispose();
        registry = new RepositoryRegistry();
        await registry.initialize(nestedWorkspace, containingRepository);

        const [descriptor] = await registry.replace([{ repositoryRoot: containingRepository }]);
        const owner = await registry.resolveOwner(workspaceFile);

        expect(descriptor.workspaceRelativeRoot).toBe('.');
        expect(owner.canonicalRoot).toBe(await fs.realpath(containingRepository));
    });

    it('rejects files whose canonical path escapes through a symlink', async () => {
        const outsideDirectory = path.join(tempDir, 'outside');
        const outsideFile = path.join(outsideDirectory, 'README.md');
        const linkedDirectory = path.join(workspaceRoot, 'linked');
        await fs.mkdir(outsideDirectory);
        await fs.writeFile(outsideFile, '# Outside');
        await fs.symlink(outsideDirectory, linkedDirectory);
        await registry.replace([{ repositoryRoot: rootRepository }]);

        await expect(registry.resolveOwner(path.join(linkedDirectory, 'README.md')))
            .rejects.toThrow('escapes the configured workspace root');
    });

    it('deduplicates registrations that resolve to the same canonical root', async () => {
        const nestedAlias = path.join(workspaceRoot, 'nested-alias');
        await fs.symlink(nestedRepository, nestedAlias);

        const descriptors = await registry.replace([
            { repositoryRoot: nestedRepository },
            { repositoryRoot: nestedAlias }
        ]);

        expect(descriptors).toHaveLength(1);
    });

    it('uses stable repository identities across registry refreshes', async () => {
        const [first] = await registry.replace([{ repositoryRoot: nestedRepository }]);
        const [second] = await registry.replace([{ repositoryRoot: nestedRepository }]);

        expect(second.repositoryId).toBe(first.repositoryId);
        expect(second.fingerprint).toBe(first.fingerprint);
    });

    it('suppresses repository change events when the descriptor set is unchanged', async () => {
        const listener = jest.fn();
        registry.onDidChangeRepositories(listener);

        await registry.replace([{ repositoryRoot: nestedRepository }]);
        await registry.replace([{ repositoryRoot: nestedRepository }]);

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fails closed for unknown repository IDs', async () => {
        await registry.replace([{ repositoryRoot: nestedRepository }]);

        expect(() => registry.requireRepository('missing')).toThrow('Unknown repository');
    });

    it('keeps authoritative host Git metadata when a source shares its canonical root', async () => {
        const git = {
            configRevision: 'host-revision',
            mode: 'push' as const,
            publishEnabled: true,
            branch: 'main',
            remote: 'origin',
            pushUrl: 'git@example.test:owner/repo.git',
            authorName: 'Studio',
            authorEmail: 'studio@example.test'
        };

        const [descriptor] = await registry.replace([
            { repositoryRoot: rootRepository, sourceId: 'workspace-source' },
            { repositoryRoot: rootRepository, git }
        ]);

        expect(descriptor.git).toEqual(git);
    });

    it('allows external git metadata for an in-workspace worktree', async () => {
        const externalGitDirectory = path.join(tempDir, 'gitdirs', 'nested');
        const externalCommonDirectory = path.join(tempDir, 'git-common');
        await fs.mkdir(externalGitDirectory, { recursive: true });
        await fs.mkdir(externalCommonDirectory);

        const [descriptor] = await registry.replace([{
            repositoryRoot: nestedRepository,
            gitDirectory: externalGitDirectory,
            commonDirectory: externalCommonDirectory
        }]);

        expect(descriptor.workspaceRelativeRoot).toBe('sources/nested');
        expect(registry.requireRepository(descriptor.repositoryId).canonicalCommonDirectory)
            .toBe(await fs.realpath(externalCommonDirectory));
    });

    it('allows explicitly configured external repository roots without weakening default containment', async () => {
        const externalRepository = path.join(tempDir, 'external');
        const externalFile = path.join(externalRepository, 'README.md');
        await fs.mkdir(externalRepository);
        await fs.writeFile(externalFile, '# External');

        const [descriptor] = await registry.replace(
            [{ repositoryRoot: externalRepository, sourceId: 'external' }],
            { allowConfiguredExternalRoots: [externalRepository] }
        );

        expect(descriptor.workspaceRelativeRoot).toBe('.');
        await expect(registry.resolveOwner(externalFile)).resolves.toMatchObject({
            canonicalRoot: await fs.realpath(externalRepository)
        });
    });
});
