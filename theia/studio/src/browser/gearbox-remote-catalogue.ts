import { Emitter } from '@theia/core/lib/common/event';
import { StudioApi } from './studio-api';

/**
 * The key gearbox-studio's `CatalogueStore` asks for a remote catalogue under
 * (`RemoteCatalogueSource` there). A `Symbol.for` key, so this extension binds
 * it without importing gearbox-studio.
 */
export const GEARBOX_REMOTE_CATALOGUE = Symbol.for('gearbox-studio.RemoteCatalogueSource');

export interface RemoteGearCatalogue {
    /** `owner/repo@ref` of the backend's corpus checkout. */
    readonly corpus: string;
    /** Each a Gearbox `GearDescriptor`, passed through untouched. */
    readonly gears: readonly unknown[];
    /** Where a copy of the corpus can be cloned from, at the listed commit. */
    readonly origin?: { readonly sourceId: string; readonly url: string; readonly rev: string; readonly needsToken: boolean };
}

type Fetch = (path: string) => Promise<Response>;

/**
 * Fired when what the backend would answer may have changed. The desktop
 * starts signed out, so the catalogue's first load gets nothing (the local
 * `/studio-api` proxy answers 503); signing in is when to ask again.
 */
export const remoteGearCatalogueChanged = new Emitter<void>();

/**
 * The gear corpus's catalogue, from the one checkout the Studio backend keeps.
 *
 * A workspace that holds no gear corpus -- a desktop project whose only
 * repository is its own -- lists the gears from here instead of cloning the
 * corpus into every project. Undefined when the backend offers no corpus
 * (Gearbox off, or not reachable), so the catalogue falls back to the empty
 * engine answer rather than reporting an error.
 */
export async function loadRemoteGearCatalogue(fetchApi: Fetch = path => StudioApi.fetch(path)): Promise<RemoteGearCatalogue | undefined> {
    const res = await fetchApi('/studio-components-catalog/v1/gearbox/catalogue');
    if (!res.ok) {
        return undefined;
    }
    const body = await res.json() as {
        corpus?: string;
        source_id?: string;
        corpus_url?: string;
        corpus_commit?: string | null;
        corpus_needs_token?: boolean;
        catalogue?: { gears?: Record<string, unknown> };
    };
    const gears = Object.values(body.catalogue?.gears ?? {});
    if (gears.length === 0) {
        return undefined;
    }
    const origin = body.source_id && body.corpus_url && body.corpus_commit
        ? { sourceId: body.source_id, url: body.corpus_url, rev: body.corpus_commit, needsToken: body.corpus_needs_token === true }
        : undefined;
    return { corpus: body.corpus ?? 'the gear corpus', gears, ...(origin ? { origin } : {}) };
}
