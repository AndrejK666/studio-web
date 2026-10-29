import { ProductDescriptions } from './gearbox-product-descriptions';

const reply = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const project = async () => ({ kind: 'project' as const, workspaceId: 'w', projectId: 'p-1' });
const PATH = '/studio-product/v1/product-description?project_id=p-1';
const REV = { revision: 3, text: 'product shop {}', author: 'u', created_at: '2026-10-29T10:00:00Z', sha256: 'x', source: 'studio' };

describe('the product description Studio keeps (ADR-0053)', () => {
    it('reads the latest revision of the project the folder was opened for', async () => {
        const asked: string[] = [];
        const d = new ProductDescriptions(project, async path => {
            asked.push(path);
            return reply(200, { latest: REV });
        });
        expect(await d.latest('/home/a/p/products/shop/product.gdl')).toEqual({
            revision: 3, text: 'product shop {}', author: 'u', createdAt: '2026-10-29T10:00:00Z',
        });
        expect(asked).toEqual([PATH]);
    });

    it('saves against the base revision, and answers a conflict with both texts', async () => {
        const bodies: unknown[] = [];
        const saved = new ProductDescriptions(project, async (_path, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return reply(200, { revision: { ...REV, revision: 4 }, created: true });
        });
        expect(await saved.save('/p/product.gdl', 'mine', 3)).toEqual({ kind: 'saved', revision: 4 });
        expect(bodies).toEqual([{ text: 'mine', base_revision: 3 }]);

        const stale = new ProductDescriptions(project, async () =>
            reply(409, { reason: 'DESCRIPTION_REVISION_STALE', latest: { ...REV, revision: 5, text: 'theirs' }, yours: 'mine' }));
        expect(await stale.save('/p/product.gdl', 'mine', 3)).toEqual({
            kind: 'conflict',
            latest: { revision: 5, text: 'theirs', author: 'u', createdAt: '2026-10-29T10:00:00Z' },
            yours: 'mine',
        });
    });

    it('outside a Studio project, or where Studio keeps none, reads and saves nothing', async () => {
        const nowhere = new ProductDescriptions(async () => undefined, async () => {
            throw new Error('not asked');
        });
        expect(await nowhere.latest('/x/product.gdl')).toBeUndefined();
        expect(await nowhere.save('/x/product.gdl', 't', undefined)).toEqual({ kind: 'none' });
        const kept = new ProductDescriptions(project, async () => reply(503, {}));
        expect(await kept.latest('/p/product.gdl')).toBeUndefined();
        expect(await kept.save('/p/product.gdl', 't', undefined)).toEqual({ kind: 'none' });
    });
});
