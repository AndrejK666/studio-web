import { StudioApi } from './studio-api';
import type { AnalyzeScope } from './analyze-studio-client';
import { foldersAbove } from './gearbox-deploy-environments';

/**
 * The key gearbox-studio reads and saves a product's description under
 * (`ProductDescriptions` there, ADR-0053). A `Symbol.for` key, so this
 * extension binds it without importing gearbox-studio; the shapes mirror its
 * `common/protocol.ts`.
 */
export const GEARBOX_PRODUCT_DESCRIPTIONS = Symbol.for('gearbox-studio.ProductDescriptions');

/** One revision of the description Studio keeps. */
export interface StudioDescriptionRevision {
    readonly revision: number;
    readonly text: string;
    readonly author?: string;
    readonly createdAt?: string;
}

/** What a save did: a new revision, a conflict with both texts, or nothing (no Studio project here). */
export type DescriptionSave =
    | { readonly kind: 'saved'; readonly revision: number }
    | { readonly kind: 'conflict'; readonly latest: StudioDescriptionRevision; readonly yours: string }
    | { readonly kind: 'none' };

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;
type Scope = (roots: readonly string[]) => Promise<AnalyzeScope | undefined>;

const revisionOf = (v: unknown): StudioDescriptionRevision | undefined => {
    const r = (v ?? {}) as Record<string, unknown>;
    return typeof r.revision === 'number' && typeof r.text === 'string'
        ? {
            revision: r.revision,
            text: r.text,
            ...(typeof r.author === 'string' ? { author: r.author } : {}),
            ...(typeof r.created_at === 'string' ? { createdAt: r.created_at } : {}),
        }
        : undefined;
};

/**
 * The description of the project a product's folder was opened for, as
 * Studio keeps it (ADR-0053 §1): read the latest revision, save a new one
 * against the revision the editor started from. A product outside a Studio
 * project, a member signed out, or a Studio that keeps no descriptions (503)
 * reads as none and saves nothing.
 */
export class ProductDescriptions {
    constructor(
        protected readonly scope: Scope,
        protected readonly fetchApi: Fetch = (path, init) => StudioApi.fetch(path, init),
    ) { }

    /** `?project_id=` of the project `file` belongs to; undefined outside one. */
    protected async project(file: string): Promise<string | undefined> {
        const scope = await this.scope(foldersAbove(file));
        return scope?.kind === 'project' ? `?project_id=${encodeURIComponent(scope.projectId)}` : undefined;
    }

    async latest(file: string): Promise<StudioDescriptionRevision | undefined> {
        const project = await this.project(file);
        if (project === undefined) {
            return undefined;
        }
        const res = await this.fetchApi(`/studio-product/v1/product-description${project}`);
        if (!res.ok) {
            return undefined;
        }
        const body = (await res.json().catch(() => ({}))) as { latest?: unknown };
        return revisionOf(body.latest);
    }

    async save(file: string, text: string, baseRevision: number | undefined): Promise<DescriptionSave> {
        const project = await this.project(file);
        if (project === undefined) {
            return { kind: 'none' };
        }
        const res = await this.fetchApi(`/studio-product/v1/product-description-revisions${project}`, {
            method: 'POST',
            body: JSON.stringify({ text, ...(baseRevision !== undefined ? { base_revision: baseRevision } : {}) }),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status === 409) {
            const latest = revisionOf(body.latest);
            if (latest !== undefined) {
                return { kind: 'conflict', latest, yours: text };
            }
        }
        if (res.status === 503) {
            return { kind: 'none' };
        }
        if (!res.ok) {
            throw new Error(`the Studio server did not keep the description (HTTP ${res.status})`);
        }
        const saved = revisionOf(body.revision);
        if (saved === undefined) {
            throw new Error('the Studio server answered the save without a revision');
        }
        return { kind: 'saved', revision: saved.revision };
    }
}
