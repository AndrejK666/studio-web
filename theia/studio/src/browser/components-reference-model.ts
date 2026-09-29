import { StudioApi } from './studio-api';

/*
 * The components reference, as the IDE reads it.
 *
 * One read — `GET /studio-components-catalog/v1/reference` — serves the whole
 * list: the portal's component catalogue (crates.io release and downloads,
 * repository scans, profile, activity) joined on the server with the Gearbox
 * engine's gears (engine id, role, extension points). The join, the nulls and
 * the counts are the backend's (`components_catalog/reference.rs`); this file
 * only shapes what the widget draws, so the rules are testable without a
 * widget, a Studio or a desktop.
 *
 * It goes through `StudioApi.fetch`, which the portal session and the desktop
 * both answer (the desktop through its `/studio-api` proxy), so there is no
 * host branch here.
 */

export const REFERENCE_PATH = '/studio-components-catalog/v1/reference';

/** The command gearbox-studio registers for "put a gear into the product". */
export const ADD_GEAR_COMMAND = 'gearbox.product.addGear';

export interface ReferenceExtensionPoint {
    readonly spec: string;
    readonly interface: string | null;
    readonly sdk_crate: string | null;
}

export interface ReferenceEngineGear {
    readonly id: string;
    readonly display_name: string | null;
    readonly role: 'service' | 'plugin' | string;
    readonly category: string | null;
    readonly gdl_path: string | null;
    readonly runtime_caps: readonly string[];
    readonly colocated_deps: readonly string[];
    readonly extension_points: readonly ReferenceExtensionPoint[];
    readonly fills: string | null;
    readonly hosts: readonly string[];
    readonly plugins: readonly string[];
}

export interface ReferenceRelatedCrate {
    readonly name: string;
    readonly role: 'sdk' | 'plugin' | 'implements' | 'crate' | string;
    readonly in_catalogue: boolean;
    readonly gear_id: string | null;
}

export interface ReferenceActivity {
    readonly commits: number;
    readonly files_changed: number;
    readonly lines_added: number;
    readonly lines_removed: number;
    readonly authors: number;
}

export interface ReferenceEntry {
    readonly name: string;
    readonly aka?: readonly string[];
    readonly instance_id?: string | null;
    readonly title: string | null;
    readonly type_id: string | null;
    /** One vocabulary, decided by the backend (`components_catalog/taxonomy.rs`). */
    readonly kind: string;
    readonly kind_reason?: string;
    /** False for config, test support, docs, templates, examples and superseded nodes. */
    readonly component?: boolean;
    readonly excluded_reason?: string | null;
    readonly superseded_by?: string | null;
    readonly category: string | null;
    readonly category_reason?: string | null;
    readonly source_categories?: readonly string[];
    readonly description: string | null;
    readonly status: string | null;
    readonly version: string | null;
    readonly version_source: 'crates.io' | 'declared' | string | null;
    readonly num_versions: number | null;
    readonly downloads: number | null;
    readonly recent_downloads: number | null;
    readonly updated_at: string | null;
    readonly repository: string | null;
    readonly repo_path: string | null;
    readonly synced_from: string | null;
    readonly sources: readonly string[];
    readonly profile_filled: number | null;
    readonly profile_fields: number | null;
    readonly activity: ReferenceActivity | null;
    readonly engine: readonly ReferenceEngineGear[];
    readonly related: readonly ReferenceRelatedCrate[];
}

export interface ReferenceSources {
    readonly gearbox_corpus: string | null;
    readonly gearbox_problem: string | null;
    readonly activity_days: number | null;
    readonly activity_from: string | null;
    readonly activity_to: string | null;
    readonly activity_problem: string | null;
    readonly excluded?: number;
    readonly cached?: boolean;
}

export interface ComponentsReference {
    readonly items: readonly ReferenceEntry[];
    readonly total: number;
    readonly truncated: boolean;
    readonly sources: ReferenceSources;
}

/** What loading ended in: the list, or a sentence a person can act on. */
export type ReferenceLoad =
    | { readonly kind: 'ok'; readonly reference: ComponentsReference }
    | { readonly kind: 'error'; readonly message: string };

type Fetch = (path: string) => Promise<Response>;

/**
 * Read the reference. Never throws: a failure becomes a message that says
 * what the person can do — "no data" and "no access" read differently.
 */
export async function loadComponentsReference(
    fetchApi: Fetch = path => StudioApi.fetch(path),
    days = 90,
): Promise<ReferenceLoad> {
    let res: Response;
    try {
        // `include=all`: the view hides what is not a component itself, behind a
        // filter that shows each one with its reason, rather than asking twice.
        res = await fetchApi(`${REFERENCE_PATH}?days=${days}&include=all`);
    } catch (e) {
        return { kind: 'error', message: `Studio could not be reached: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) {
        return { kind: 'error', message: failureMessage(res.status) };
    }
    try {
        const body = await res.json() as ComponentsReference;
        return { kind: 'ok', reference: { ...body, items: body.items ?? [] } };
    } catch {
        return { kind: 'error', message: 'Studio answered with something that is not a components reference.' };
    }
}

export function failureMessage(status: number): string {
    switch (status) {
        case 401:
            return 'You are not signed in to Studio, so the components cannot be read. Sign in and reload.';
        case 403:
            return 'Your Studio account may not read the component catalogue.';
        case 404:
            return 'This Studio does not serve the components reference yet (its backend is older than the IDE).';
        case 503:
            return 'Studio is not reachable from this IDE right now. Sign in, or try again in a moment.';
        default:
            return `Studio could not list the components (HTTP ${status}).`;
    }
}

/** The component kinds, in the order the filter offers them; anything else follows. */
const KIND_ORDER = ['gear', 'plugin', 'sdk', 'library', 'micro-frontend', 'frontend-library', 'tool', 'kit'];

/** How a kind reads on a chip. */
export const KIND_LABELS: Record<string, string> = {
    'gear': 'gear',
    'plugin': 'plugin',
    'sdk': 'SDK',
    'library': 'library',
    'micro-frontend': 'micro-frontend',
    'frontend-library': 'frontend library',
    'tool': 'tool / CLI',
    'kit': 'kit',
    'config': 'config',
    'test-support': 'test support',
    'docs': 'docs',
    'template': 'template',
    'example': 'example',
    'superseded': 'superseded',
};

export function kindLabel(kind: string): string {
    return KIND_LABELS[kind] ?? kind;
}

/** Whether an entry is a component (older backends send no flag: assume yes). */
export function isComponent(e: ReferenceEntry): boolean {
    return e.component !== false;
}

/** How many entries per category, components only, unfiled last. */
export function categoryCounts(items: readonly ReferenceEntry[]): Array<{ category: string | null; count: number }> {
    const counts = new Map<string | null, number>();
    for (const e of items.filter(isComponent)) {
        counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => (a.category === null ? 1 : 0) - (b.category === null ? 1 : 0)
            || (a.category ?? '').localeCompare(b.category ?? ''));
}

/** How many entries of each kind, for the filter chips, in a stable order. */
export function kindCounts(items: readonly ReferenceEntry[]): Array<{ kind: string; count: number }> {
    const counts = new Map<string, number>();
    for (const e of items.filter(isComponent)) {
        counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    }
    const rank = (k: string) => {
        const i = KIND_ORDER.indexOf(k);
        return i < 0 ? KIND_ORDER.length : i;
    };
    return [...counts.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind));
}

export interface ReferenceFilter {
    readonly query: string;
    /** Empty means every kind. */
    readonly kinds: ReadonlySet<string>;
    /** Only what can be put into a product (has an engine gear). */
    readonly addableOnly: boolean;
    /** Empty means every category; `''` stands for "no category". */
    readonly categories?: ReadonlySet<string>;
    /** Show what is not a component (and superseded nodes) instead of the components. */
    readonly excluded?: boolean;
}

/**
 * The entries a filter keeps. The search matches the name, the title, the
 * description, the category and every engine id, so `account-management`
 * finds `cf-gears-account-management`.
 */
export function filterEntries(items: readonly ReferenceEntry[], filter: ReferenceFilter): ReferenceEntry[] {
    const needle = filter.query.trim().toLowerCase();
    return items.filter(e => {
        if (isComponent(e) === (filter.excluded === true)) {
            return false;
        }
        if (filter.kinds.size > 0 && !filter.excluded && !filter.kinds.has(e.kind)) {
            return false;
        }
        if (filter.categories && filter.categories.size > 0 && !filter.excluded
            && !filter.categories.has(e.category ?? '')) {
            return false;
        }
        if (filter.addableOnly && e.engine.length === 0) {
            return false;
        }
        if (!needle) {
            return true;
        }
        const hay = [e.name, e.title, e.description, e.category, ...(e.aka ?? []), ...e.engine.map(g => g.id)]
            .filter((s): s is string => typeof s === 'string')
            .join('\n')
            .toLowerCase();
        return hay.includes(needle);
    });
}

/** `1,234` — or a dash for unknown, which is not zero. */
export function countText(n: number | null | undefined): string {
    return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
}

/** The release cell: what the version is and where it was read. */
export function releaseText(e: ReferenceEntry): string {
    if (!e.version) {
        return e.status === 'draft' ? 'Draft — documents only, no crate' : 'Not published';
    }
    if (e.version_source === 'declared') {
        return `${e.version} (declared, not on a registry)`;
    }
    const n = typeof e.num_versions === 'number' ? ` · ${e.num_versions} versions` : '';
    return `${e.version}${n}`;
}

/** The activity cell, telling "not measured" from "measured, nothing moved". */
export function activityText(e: ReferenceEntry, sources: ReferenceSources): string {
    if (sources.activity_days === null) {
        return 'Not measured';
    }
    if (!e.activity) {
        return `No activity recorded in ${sources.activity_days} days`;
    }
    const a = e.activity;
    return `${a.commits} commits · +${a.lines_added} −${a.lines_removed} · ${a.authors} authors`;
}

/** `42%`, or null when the component's type has no schema to count against. */
export function profilePercent(e: ReferenceEntry): number | null {
    if (typeof e.profile_filled !== 'number' || typeof e.profile_fields !== 'number' || e.profile_fields === 0) {
        return null;
    }
    return Math.round((e.profile_filled / e.profile_fields) * 100);
}

/** Where the component comes from, as one line. */
export function sourceText(e: ReferenceEntry): string {
    const where = e.synced_from ?? repoShort(e.repository);
    const path = e.repo_path ? `/${e.repo_path}` : '';
    if (where) {
        return `${where}${path}`;
    }
    return e.repo_path ? `${e.repo_path} (in the gear corpus)` : 'Not recorded';
}

function repoShort(url: string | null): string | null {
    if (!url) {
        return null;
    }
    return url.replace(/^https?:\/\/(www\.)?/, '').replace(/^github\.com\//, '').replace(/\/$/, '');
}

/** The engine gears a person can add, in the order the detail lists them. */
export function addableGears(e: ReferenceEntry): readonly ReferenceEngineGear[] {
    return e.engine;
}

/** What the list says when it is empty, told apart by why. */
export function emptyMessage(total: number, shown: number): string | undefined {
    if (total === 0) {
        return 'Studio lists no components yet. An administrator syncs them on the portal\'s Components page (Sources → Sync).';
    }
    if (shown === 0) {
        return 'No component matches the search and filters.';
    }
    return undefined;
}
