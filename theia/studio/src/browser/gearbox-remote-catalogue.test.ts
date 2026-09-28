import { loadRemoteGearCatalogue } from './gearbox-remote-catalogue';

function answer(status: number, body: unknown): () => Promise<Response> {
    return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
}

describe('loadRemoteGearCatalogue', () => {
    it('passes every descriptor of the backend\'s corpus through, and names the corpus', async () => {
        const api = { id: 'api-gateway', source: 'gears-rust', gdl_path: 'gears/api-gateway/gear.gdl' };
        const authn = { id: 'authn', source: 'gears-rust', gdl_path: 'gears/authn/gear.gdl' };
        const fetchApi = jest.fn(answer(200, {
            source_id: 'gears-rust',
            corpus: 'constructorfabric/gears-rust@main',
            catalogue: { gears: { 'api-gateway': api, authn }, contracts: {}, sources: {} },
        }));

        const remote = await loadRemoteGearCatalogue(fetchApi);

        expect(fetchApi).toHaveBeenCalledWith('/studio-components-catalog/v1/gearbox/catalogue');
        expect(remote).toEqual({ corpus: 'constructorfabric/gears-rust@main', gears: [api, authn] });
    });

    it('says where a copy can be cloned from, at the commit the gears were read at', async () => {
        const remote = await loadRemoteGearCatalogue(answer(200, {
            source_id: 'gears-rust',
            corpus: 'o/gears-rust@main',
            corpus_url: 'https://github.com/o/gears-rust.git',
            corpus_ref: 'main',
            corpus_commit: 'a'.repeat(40),
            corpus_needs_token: true,
            catalogue: { gears: { g: { id: 'g' } } },
        }));

        expect(remote?.origin).toEqual({ sourceId: 'gears-rust', url: 'https://github.com/o/gears-rust.git', rev: 'a'.repeat(40), needsToken: true });
    });

    it('offers nothing when the backend has no corpus, so the catalogue stays empty rather than failing', async () => {
        expect(await loadRemoteGearCatalogue(answer(500, {}))).toBeUndefined();
        expect(await loadRemoteGearCatalogue(answer(200, { corpus: 'x', catalogue: { gears: {} } }))).toBeUndefined();
    });
});
