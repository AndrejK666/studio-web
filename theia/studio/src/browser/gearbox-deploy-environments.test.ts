import { DeployEnvironments, foldersAbove } from './gearbox-deploy-environments';

const json = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('the organization\'s environments, for the desktop\'s Deploy', () => {
    it('look for the opened folder among those above the product', () => {
        expect(foldersAbove('C:\\Users\\a\\ConstructorStudio\\p\\products\\shop\\product.gdl').slice(0, 3)).toEqual([
            'C:\\Users\\a\\ConstructorStudio\\p\\products\\shop',
            'C:\\Users\\a\\ConstructorStudio\\p\\products',
            'C:\\Users\\a\\ConstructorStudio\\p',
        ]);
        expect(foldersAbove('/home/a/p/product.gdl')).toEqual(['/home/a/p', '/home/a', '/home']);
    });

    it('are read for the project the folder was opened for', async () => {
        const asked: string[] = [];
        const source = new DeployEnvironments(
            async () => ({ kind: 'project', workspaceId: 'w', projectId: 'p-1' }),
            async path => {
                asked.push(path);
                return json(200, {
                    environments: [{ environment: { id: 'e1', name: 'prod', registry: 'ghcr.io/acme', protected: true }, namespace: 'shop-prod' }],
                    bindings: [{ profile: 'prod', environment_id: 'e1' }],
                });
            },
        );
        await expect(source.targets('/p/product.gdl')).resolves.toEqual({
            projectId: 'p-1',
            environments: [{ id: 'e1', name: 'prod', namespace: 'shop-prod', registry: 'ghcr.io/acme', protected: true }],
            bound: { prod: 'e1' },
        });
        expect(asked).toEqual(['/studio-environments/v1/targets?project_id=p-1']);
    });

    it('are none outside a Studio project, or from a Studio without them', async () => {
        const outside = new DeployEnvironments(async () => undefined, async () => json(200, {}));
        await expect(outside.targets('/x/product.gdl')).resolves.toBeUndefined();
        const old = new DeployEnvironments(async () => ({ kind: 'project', workspaceId: 'w', projectId: 'p' }), async () => json(404, {}));
        await expect(old.targets('/x/product.gdl')).resolves.toBeUndefined();
    });

    it('take a deploy, and pass on the server\'s refusal in its words', async () => {
        let sent: RequestInit | undefined;
        const ok = new DeployEnvironments(async () => undefined, async (_path, init) => {
            sent = init;
            return json(202, { state: 'awaiting_approval', environment_name: 'prod', namespace: 'shop-prod' });
        });
        await expect(ok.requestDeploy('p-1', { environment_id: 'e1' })).resolves.toMatchObject({ state: 'awaiting_approval' });
        expect(sent?.method).toBe('POST');
        const refused = new DeployEnvironments(async () => undefined, async () => json(400, { detail: 'the chart is not a packaged .tgz' }));
        await expect(refused.requestDeploy('p-1', {})).rejects.toThrow('the chart is not a packaged .tgz');
    });
});
