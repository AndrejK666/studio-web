/**
 * The platform's catalogue on the kit's DataGrid, the way Specs draws its list
 * (#1076): the search over names and descriptions, the category, Hide SDKs and
 * component-type filters, header sort by name or downloads, pages, the list's
 * empty state, and the "compare with" window in the grid's toolbar. A click on
 * a row opens the component's page.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Badge,
  DataGridActionsPlugin,
  DataGridRowClickPlugin,
  NativeSelect,
  NativeSelectOption,
  filterTagGroup,
  filterToggle,
  type DataGridFilterEntity,
  type DataGridLoadContext,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  pageOfRows,
  searchQuery,
  tagGroupChoice,
  useLocalGridReload,
} from '@constructor-studio/mfe-shared/grid';
import type { CatalogNode } from '../../api/types';
import { categoriesOf, filterCatalogue, nameOf, rowFacts, schemaFor, type RowFacts, type SortMode } from '../../model/catalogue';
import { COMPONENT_KIND_LABELS, NOT_COMPONENTS, inKindFilter, kindChips } from '../../model/component-kinds';
import { readinessOf } from '../../model/readiness';
import { reviewCounts, reviewOf, type ReviewPart } from '../../model/review-summary';
import type { Text } from './common';
import { TrendMark, WINDOWS } from './ComponentPage';
import { OutLink } from './parts';
import type { useBaselines, useCatalogue } from './useCatalogue';
import styles from './ComponentsScreen.module.css';

type Resolved = ReturnType<typeof useCatalogue>['data']['resolved'];

/** A row of the grid: one catalogue node. */
export interface CatalogueRow {
  id: string;
  node: CatalogNode;
}

/** The filter keys the grid hands `load`. */
export const CATALOGUE_FILTERS = {
  category: 'category',
  hideSdks: 'hide_sdks',
  kind: 'kind',
} as const;

/** The column order maps to the sort the toolbar's select offered. */
function sortOf(order: DataGridLoadContext['order']): SortMode {
  const first = order?.[0];
  if (first?.column === 'downloads') return first.direction === 'asc' ? 'downloads-asc' : 'downloads-desc';
  return first?.column === 'component' && first.direction === 'desc' ? 'name-desc' : 'name-asc';
}

/**
 * The rows the grid's search, filters and order keep, by the catalogue's own
 * rules (`filterCatalogue`, `inKindFilter`): no kind chosen is every component,
 * without the nodes that are not components.
 */
export function catalogueRows(
  nodes: readonly CatalogNode[],
  context: DataGridLoadContext,
  componentTypes: Set<string> | null,
  resolved: Resolved
): CatalogueRow[] {
  const filters = context.filters ?? {};
  const kind = tagGroupChoice(filters[CATALOGUE_FILTERS.kind]) ?? '';
  return filterCatalogue(nodes, {
    q: searchQuery(filters),
    category: tagGroupChoice(filters[CATALOGUE_FILTERS.category]) ?? '',
    hideSdk: filters[CATALOGUE_FILTERS.hideSdks]?.value === true,
    sort: sortOf(context.order),
    componentTypes,
    resolvedCategory: (name) => resolved[name]?.category,
  })
    .filter((g) => inKindFilter(g, kind))
    .map((node) => ({ id: node.instance_id, node }));
}

/** What a cell needs beyond its row. */
interface CatalogueCells {
  t: Text;
  /** A row's facts, by its node's instance id. */
  facts: Map<string, RowFacts>;
  days: number;
  onDays: (days: number) => void;
}

const [CatalogueCellsProvider, useCatalogueCells] = createGridCells<CatalogueCells>('Catalogue');

const NameCell: React.FC<{ item: CatalogueRow }> = ({ item }) => {
  const { t, facts } = useCatalogueCells();
  const name = nameOf(item.node);
  return (
    <div data-component-row={name}>
      <div className={styles.name}>{name}</div>
      {item.node.value.description && <div className={styles.purpose}>{String(item.node.value.description)}</div>}
      <SourceChips sources={facts.get(item.id)?.sources} t={t} />
    </div>
  );
};

const TypeCell: React.FC<{ item: CatalogueRow }> = ({ item }) => {
  const f = useCatalogueCells().facts.get(item.id);
  if (!f) return null;
  return (
    <>
      <Badge variant="secondary" title={f.excluded ?? f.kindReason}>
        {COMPONENT_KIND_LABELS[f.kind] ?? f.kind}
      </Badge>
      {f.category && f.category !== f.kind && <div className={styles.sub}>{f.category}</div>}
    </>
  );
};

const ReleaseCell: React.FC<{ item: CatalogueRow }> = ({ item }) => {
  const { t, facts } = useCatalogueCells();
  const f = facts.get(item.id);
  if (!f?.version) return null;
  return (
    <span data-release={f.declared ? 'declared' : 'published'}>
      <code
        className={styles.version}
        title={
          f.declared
            ? t('declared_in_repository')
            : t('versions_on_crates', { count: String(item.node.value.num_versions ?? '—') })
        }
      >
        {String(f.version)}
      </code>
      {!!f.declared && (
        <span className={styles.muted} role="img" aria-label={t('not_on_crates')} title={t('not_on_crates')}>
          {' ⊘'}
        </span>
      )}
    </span>
  );
};

const ReadinessColumn: React.FC<{ item: CatalogueRow }> = ({ item }) => {
  const { t, facts } = useCatalogueCells();
  const f = facts.get(item.id);
  return f ? <ReadinessCell values={f.values} t={t} /> : null;
};

const DownloadsCell: React.FC<{ item: CatalogueRow }> = ({ item }) =>
  item.node.value.downloads != null ? (
    <div className={styles.num}>{Number(item.node.value.downloads).toLocaleString('en-US')}</div>
  ) : null;

const ReviewColumn: React.FC<{ item: CatalogueRow }> = ({ item }) => {
  const { t, facts } = useCatalogueCells();
  const f = facts.get(item.id);
  return f ? <ReviewCell parts={(f.values.grade as { parts?: ReviewPart[] } | null | undefined)?.parts} t={t} /> : null;
};

const ProfileColumn: React.FC<{ item: CatalogueRow }> = ({ item }) => {
  const { t, facts } = useCatalogueCells();
  const f = facts.get(item.id);
  return f ? <ProfileCell facts={f} t={t} /> : null;
};

const SourceCell: React.FC<{ item: CatalogueRow }> = ({ item }) => {
  const repository = useCatalogueCells().facts.get(item.id)?.repository;
  if (!repository) return null;
  return (
    <span data-grid-row-ignore-click>
      <OutLink href={repository} title={repository}>
        {repository.replace(/^https?:\/\/(www\.)?/, '')}
      </OutLink>
    </span>
  );
};

/** The window the profile's trend compares over, in the grid's toolbar. */
const WindowPicker: React.FC = () => {
  const { t, days, onDays } = useCatalogueCells();
  return (
    <NativeSelect aria-label={t('window')} value={String(days)} onChange={(e) => onDays(Number(e.target.value))}>
      {WINDOWS.map((w) => (
        <NativeSelectOption key={w} value={String(w)}>
          {t('since_window', { days: w })}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
};

const CatalogueEmpty: React.FC = () => {
  const { t } = useCatalogueCells();
  return (
    <GridEmpty
      title={t('no_components')}
      note={t('no_components_body')}
      noMatches={t('nothing_matches')}
      noMatchesActions={<GridClearFilters label={t('clear_filters')} />}
    />
  );
};

export function CatalogueGrid({
  levelNodes,
  componentTypes,
  resolved,
  schemas,
  baselines,
  days,
  onDays,
  onOpen,
  t,
}: {
  levelNodes: CatalogNode[];
  componentTypes: Set<string> | null;
  resolved: Resolved;
  schemas: ReturnType<typeof useCatalogue>['data']['schemas'];
  baselines: ReturnType<typeof useBaselines>['byName'];
  days: number;
  onDays: (days: number) => void;
  onOpen: (name: string) => void;
  t: Text;
}) {
  const inputs = useMemo(() => ({ levelNodes, componentTypes, resolved }), [levelNodes, componentTypes, resolved]);
  const current = useRef(inputs);
  useLayoutEffect(() => {
    current.current = inputs;
  });
  const load = useCallback(async (context: DataGridLoadContext) => {
    const { levelNodes: nodes, componentTypes: types, resolved: values } = current.current;
    const shown = catalogueRows(nodes, context, types, values);
    context.signal?.throwIfAborted();
    return pageOfRows(shown, context);
  }, []);
  // New nodes, types or resolved values are a reload, keeping the search, filters and page size.
  const reloadBridge = useLocalGridReload(inputs);

  const facts = useMemo(() => {
    const out = new Map<string, RowFacts>();
    for (const g of levelNodes) {
      const name = nameOf(g);
      out.set(
        g.instance_id,
        rowFacts(g, resolved[name]?.values ?? {}, schemaFor(schemas, g.type_id), baselines.get(name), resolved[name]?.sources)
      );
    }
    return out;
  }, [levelNodes, resolved, schemas, baselines]);

  const columns = useMemo<DataGridTableColumn<CatalogueRow>[]>(
    () => [
      { id: 'component', label: t('col_component'), component: NameCell, minWidth: 240 },
      { id: 'type', label: t('col_type'), component: TypeCell, width: 130 },
      { id: 'release', label: t('col_release'), component: ReleaseCell, width: 110 },
      { id: 'readiness', label: t('col_readiness'), component: ReadinessColumn, width: 170 },
      { id: 'downloads', label: t('col_downloads'), component: DownloadsCell, width: 120 },
      { id: 'review', label: t('col_review'), component: ReviewColumn, width: 180 },
      { id: 'profile', label: t('col_profile'), component: ProfileColumn, width: 140 },
      { id: 'source', label: t('col_source'), component: SourceCell, width: 200 },
    ],
    [t]
  );

  // The options a filter offers are the ones the nodes have: one entity list per set of them.
  const categories = categoriesOf(levelNodes, (name) => resolved[name]?.category).join('\n');
  const components = useMemo(
    () => levelNodes.filter((g) => componentTypes === null || componentTypes.has(g.type_id)),
    [levelNodes, componentTypes]
  );
  // "All" is the filter with nothing chosen; it stays out of the options.
  const kinds = kindChips(components)
    .filter((c) => c.value !== '')
    .map((c) => `${c.value}\t${c.value === NOT_COMPONENTS ? c.label : (COMPONENT_KIND_LABELS[c.value] ?? c.label)} ${c.count}`)
    .join('\n');
  const filters = useMemo(() => {
    const split = (joined: string) => (joined ? joined.split('\n') : []);
    const entities: DataGridFilterEntity[] = [];
    const categoryOptions = split(categories).map((value) => ({ value, label: value }));
    if (categoryOptions.length > 0) {
      entities.push(filterTagGroup({ id: CATALOGUE_FILTERS.category, label: t('filter_category'), mode: 'radio', options: categoryOptions }));
    }
    entities.push(filterToggle({ id: CATALOGUE_FILTERS.hideSdks, label: t('hide_sdks') }));
    const kindOptions = split(kinds).map((line) => {
      const [value, label] = line.split('\t');
      return { value, label };
    });
    if (kindOptions.length > 0) {
      entities.push(filterTagGroup({ id: CATALOGUE_FILTERS.kind, label: t('type'), mode: 'radio', options: kindOptions }));
    }
    return entities;
  }, [t, categories, kinds]);

  const cells = useMemo<CatalogueCells>(() => ({ t, facts, days, onDays }), [t, facts, days, onDays]);
  const open = useCallback((row: CatalogueRow) => onOpen(nameOf(row.node)), [onOpen]);

  return (
    <section className={styles.stack} data-catalogue>
      <CatalogueCellsProvider value={cells}>
        <ListGrid<CatalogueRow>
          name="components_catalogue"
          label={t('platform_title')}
          columns={columns}
          load={load}
          search={t('search_components')}
          filters={filters}
          empty={CatalogueEmpty}
          unsortable={['type', 'release', 'readiness', 'review', 'profile', 'source']}
          defaultOrder={{ id: 'component', direction: 'asc' }}
          minWidth="72rem"
        >
          <DataGridRowClickPlugin<CatalogueRow> click={open} />
          <DataGridActionsPlugin component={WindowPicker} />
          {reloadBridge}
        </ListGrid>
      </CatalogueCellsProvider>
    </section>
  );
}

const SOURCE_KEYS: Record<string, string> = {
  crates_io: 'source_crates',
  repository: 'source_repo',
  roadmap: 'source_roadmap',
  gearbox: 'source_gearbox',
  person: 'source_person',
};

/** Where a record's facts came from, in the order they are layered. */
export function SourceChips({ sources, t }: { sources: RowFacts['sources']; t: Text }) {
  if (!sources?.length) return null;
  const planOnly = sources.every((s) => s.kind === 'roadmap');
  return (
    <div className={styles.chips} aria-label={t('sources')}>
      {planOnly && <Badge variant="info">{t('planned_no_code')}</Badge>}
      {sources.map((s) => (
        <Badge key={`${s.kind}:${s.label}`} variant="secondary" title={s.label}>
          {SOURCE_KEYS[s.kind] ? t(SOURCE_KEYS[s.kind]) : s.kind}
          {s.kind === 'repository' || s.kind === 'roadmap' ? `: ${s.label}` : ''}
        </Badge>
      ))}
    </div>
  );
}

/** SPEC / SDK / IMPL as the board sets them, with what the repository shows (readiness.ts). */
function ReadinessCell({ values, t }: { values: RowFacts['values']; t: Text }) {
  const r = readinessOf(values as Parameters<typeof readinessOf>[0]);
  if (!r) return <span className={styles.absent}>{t('not_planned')}</span>;
  return (
    <div className={styles.ready}>
      {r.bars.map((b) => (
        <span key={b.axis} className={styles.readyBar} title={`${b.label}: ${b.pct === null ? 'N/A' : `${b.pct}%`}`}>
          <span className={styles.readyKey}>{b.axis}</span>
          <span className={styles.bar}>
            <span className={styles.barFill} style={{ width: `${b.pct ?? 0}%` }} />
          </span>
          <span className={styles.readyValue}>{b.pct === null ? '—' : `${b.pct}%`}</span>
        </span>
      ))}
      {r.evidence.length > 0 && <div className={styles.sub}>{r.evidence.map((e) => e.text).join(' · ')}</div>}
      {r.gaps.length > 0 && (
        <div className={styles.warnText} title={r.gaps.join('\n')}>
          {t('board_ahead')}
        </div>
      )}
    </div>
  );
}

/** The one check to look at first, and how many more (review-summary.ts). Opening it does not open the row. */
function ReviewCell({ parts, t }: { parts: ReviewPart[] | undefined; t: Text }) {
  const summary = reviewOf(parts);
  if (!summary) return <span className={styles.absent}>{t('not_graded')}</span>;
  const counts = reviewCounts(summary);
  if (!summary.top || !counts) return <span className={styles.okText}>{t('no_open_checks')}</span>;
  const items = [...summary.toReview, ...summary.noData];
  return (
    <details className={styles.review} data-grid-row-ignore-click>
      <summary title={summary.top.fix}>
        <span className={summary.top.known === false ? styles.muted : undefined}>{summary.top.label}</span>
        <span className={styles.sub}>{counts}</span>
      </summary>
      <ul>
        {items.map((p) => (
          <li key={`${p.area}:${p.label}`}>
            <b>{p.label}</b>{' '}
            <span className={styles.sub}>
              {p.known === false ? `${t('no_data')} · ` : ''}
              {p.fix}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ProfileCell({ facts: { fields, pct, bad, watch, trend }, t }: { facts: RowFacts; t: Text }) {
  return (
    <>
      {fields.length === 0 ? (
        <span className={styles.absent}>{t('no_schema')}</span>
      ) : (
        <div className={styles.profile}>
          <span className={styles.bar}>
            <span className={styles.barFill} style={{ width: `${pct}%` }} />
          </span>
          <span>{pct}%</span>
          {bad > 0 && <Badge variant="danger">{bad}</Badge>}
          {watch > 0 && <Badge variant="warning">{watch}</Badge>}
        </div>
      )}
      {trend && trend.better + trend.worse > 0 && (
        <div className={styles.sub}>
          <TrendMark trend={trend} t={t} />
        </div>
      )}
    </>
  );
}
