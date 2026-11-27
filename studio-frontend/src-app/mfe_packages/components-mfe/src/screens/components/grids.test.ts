import { describe, expect, it } from 'vitest';
import type { CatalogNode, RegistryEntry } from '../../api/types';
import { CATALOGUE_FILTERS, catalogueRows } from './CatalogueGrid';
import { REGISTRY_FILTERS, keepsRegistryRow, registryRows, type RegistryRow } from './RegistryGrid';

describe('the type a row shows', () => {
  it('is the catalogue’s, and the type filter keeps only that type', () => {
    const nodes = [
      { type_id: 'g', instance_id: 'a', value: { name: 'a', component_kind: 'gear', component_type: 'gear' } },
      { type_id: 'g', instance_id: 'b', value: { name: 'b', component_kind: 'micro-frontend', component_type: 'mfe' } },
    ] as CatalogNode[];
    const shown = catalogueRows(nodes, { filters: { [CATALOGUE_FILTERS.type]: { value: ['mfe'] } } }, null, {});
    expect(shown.map((r) => r.node.value.name)).toEqual(['b']);
    const rows = registryRows([
      { key: 'r:x', name: 'x', kind: 'plugin', description: '', state: 'declared', entry: { name: 'x', kind: 'plugin', state: 'declared', capabilities: [], orphaned: false, occurrences: [] } },
      { key: 'c:b', name: 'b', kind: 'frontx', description: '', state: 'published', node: nodes[1] },
    ]);
    expect(rows.map((r) => r.type)).toEqual(['plugin', 'mfe']);
  });
});

const node = (name: string, value: Record<string, unknown> = {}): CatalogNode => ({
  type_id: 'gts.cf.studio.catalog.gear.v1~',
  instance_id: `g:${name}`,
  value: { name, description: `${name} does things`, ...value },
});

// A classifying backend: the kind and category are its own.
const NODES = [
  node('billing', { downloads: 5, component_kind: 'gear', component_category: 'finance' }),
  node('audit', { downloads: 50, component_kind: 'gear', component_category: 'security' }),
  node('audit-sdk', { downloads: 9, component_kind: 'sdk', component_category: 'security' }),
  node('fixtures', { component_excluded: 'test support' }),
];

const names = (rows: { node: CatalogNode }[]) => rows.map((r) => String(r.node.value.name));
const choice = (value: string) => ({ value: [value] });

describe('the catalogue grid’s rows', () => {
  it('lists every component by name, without what is not one', () => {
    expect(names(catalogueRows(NODES, {}, null, {}))).toEqual(['audit', 'audit-sdk', 'billing']);
  });

  it('sorts by the column the header chose', () => {
    const byDownloads = catalogueRows(NODES, { order: [{ column: 'downloads', direction: 'desc' }] }, null, {});
    expect(names(byDownloads)).toEqual(['audit', 'audit-sdk', 'billing']);
    const byNameDown = catalogueRows(NODES, { order: [{ column: 'component', direction: 'desc' }] }, null, {});
    expect(names(byNameDown)).toEqual(['billing', 'audit-sdk', 'audit']);
  });

  it('searches, narrows by category and kind, and hides SDKs', () => {
    expect(names(catalogueRows(NODES, { filters: { textSearch: { value: 'bill' } } }, null, {}))).toEqual(['billing']);
    expect(names(catalogueRows(NODES, { filters: { [CATALOGUE_FILTERS.category]: choice('security') } }, null, {}))).toEqual([
      'audit',
      'audit-sdk',
    ]);
    expect(names(catalogueRows(NODES, { filters: { [CATALOGUE_FILTERS.hideSdks]: { value: true } } }, null, {}))).toEqual([
      'audit',
      'billing',
    ]);
    expect(names(catalogueRows(NODES, { filters: { [CATALOGUE_FILTERS.kind]: choice('sdk') } }, null, {}))).toEqual(['audit-sdk']);
    expect(names(catalogueRows(NODES, { filters: { [CATALOGUE_FILTERS.kind]: choice('not-components') } }, null, {}))).toEqual([
      'fixtures',
    ]);
  });

  it('keeps to the types the organization calls components', () => {
    expect(catalogueRows(NODES, {}, new Set(['gts.other~']), {})).toEqual([]);
  });
});

describe('the registry grid’s filters', () => {
  const entry = (patch: Partial<RegistryEntry> = {}): RegistryEntry => ({
    name: 'billing',
    kind: 'gear',
    state: 'declared',
    capabilities: [],
    orphaned: false,
    occurrences: [{ repo: 'acme/app', path: 'gears/billing', declared_in: 'gear.toml', project_id: 'p1', project_name: 'App' }],
    ...patch,
  });
  const row: RegistryRow = {
    id: 'r:billing',
    key: 'r:billing',
    name: 'billing',
    kind: 'gear',
    description: '',
    state: 'declared',
    type: 'gear',
    entry: entry(),
  };

  it('keeps a row under no filter, and under each that it matches', () => {
    expect(keepsRegistryRow(row, {})).toBe(true);
    expect(keepsRegistryRow(row, { [REGISTRY_FILTERS.state]: choice('declared') })).toBe(true);
    expect(keepsRegistryRow(row, { [REGISTRY_FILTERS.type]: choice('gear') })).toBe(true);
    expect(keepsRegistryRow(row, { [REGISTRY_FILTERS.project]: choice('p1') })).toBe(true);
  });

  it('drops a row another state, type or project leaves out', () => {
    expect(keepsRegistryRow(row, { [REGISTRY_FILTERS.state]: choice('candidate') })).toBe(false);
    expect(keepsRegistryRow(row, { [REGISTRY_FILTERS.type]: choice('kit') })).toBe(false);
    expect(keepsRegistryRow(row, { [REGISTRY_FILTERS.project]: choice('p2') })).toBe(false);
    // A published node no project declares is in no project.
    expect(keepsRegistryRow({ ...row, entry: undefined }, { [REGISTRY_FILTERS.project]: choice('p1') })).toBe(false);
  });
});
