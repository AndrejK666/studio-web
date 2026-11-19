/**
 * Admin › Objects' types on the kit's DataGrid, the way Specs draws its list
 * (#1076): whether a type is a component (ticked in its cell), its name, how
 * many objects it has, its namespace, its page and its id; the lenses (the
 * components, the described ones, the families) as a quick filter with their
 * counts; a search by name and id; components first, then by id, until a
 * header sorts.
 */

import React, { useMemo } from 'react';
import { Shapes } from 'lucide-react';
import { Badge, Checkbox, filterTagGroup, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import type { ScreenText } from '@constructor-studio/mfe-shared';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  tagGroupChoice,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { CatalogType, TypeCount } from '../../api/types';
import { COMPANION_TYPES, LENSES, byComponentThenId, familyOf, inLens, type Lens } from '../../model/objects';
import styles from './Admin.module.css';

/** The lens filter's key in the grid's filters. */
export const LENS_FILTER_KEY = 'lens';

/** A row of the grid: a type, by its leaf id. */
type TypeRow = CatalogType & { id: string };

/** What a cell needs beyond its row. */
interface TypeCells {
  t: ScreenText;
  language: string;
  busy: string | null;
  /** `null` when the counts could not be taken: every count is then a dash. */
  objectCounts: Record<string, TypeCount> | null;
  nameOf: (ct: CatalogType) => string;
  onToggle: (ct: CatalogType) => void;
}

const [TypeCellsProvider, useTypeCells] = createGridCells<TypeCells>('ObjectTypes');

const ComponentCell: React.FC<{ item: TypeRow }> = ({ item }) => {
  const { t, busy, nameOf, onToggle } = useTypeCells();
  const companion = COMPANION_TYPES.has(item.leaf_id);
  return (
    <span data-object-type={item.leaf_id}>
      <Checkbox
        checked={item.component}
        // An abstract type is a family: never instantiated, so a page of it would stay empty.
        disabled={item.is_abstract || companion || busy === item.leaf_id}
        title={companion ? t('objects_companion') : undefined}
        onCheckedChange={() => onToggle(item)}
        aria-label={t('objects_treat_as_component', { name: nameOf(item) })}
      />
    </span>
  );
};

const TypeCell: React.FC<{ item: TypeRow }> = ({ item }) => {
  const { t, nameOf } = useTypeCells();
  return (
    <span>
      <span className={styles.name}>{nameOf(item)}</span>{' '}
      {item.is_abstract && <Badge variant="secondary">{t('objects_family')}</Badge>}{' '}
      {!item.type_id && (
        <Badge variant="warning" title={t('objects_no_nodes_hint')}>
          {t('objects_no_nodes')}
        </Badge>
      )}
    </span>
  );
};

const ObjectsCell: React.FC<{ item: TypeRow }> = ({ item }) => {
  const { t, language, objectCounts } = useTypeCells();
  const count = objectCounts?.[item.leaf_id];
  return (
    <div className={styles.num}>
      {!objectCounts || !count ? (
        <span className={styles.sub}>—</span>
      ) : count.count === 0 ? (
        <span className={styles.sub}>0</span>
      ) : (
        <span title={count.capped ? t('objects_capped', { count: count.count }) : undefined}>
          {count.count.toLocaleString(language)}
          {count.capped && '+'}
        </span>
      )}
    </div>
  );
};

const NamespaceCell: React.FC<{ item: TypeRow }> = ({ item }) => (
  <span className={styles.sub}>{familyOf(item.leaf_id)}</span>
);

const PageCell: React.FC<{ item: TypeRow }> = ({ item }) => (
  <Badge variant={item.schema === 'tenant' ? 'info' : 'secondary'}>
    {useTypeCells().t(`objects_schema_${item.schema}`)}
  </Badge>
);

const IdCell: React.FC<{ item: TypeRow }> = ({ item }) => (
  <code className={`${styles.mono} ${styles.sub}`}>{item.leaf_id}</code>
);

const TypesEmpty: React.FC = () => {
  const { t } = useTypeCells();
  return (
    <GridEmpty
      icon={<Shapes />}
      title={t('objects_empty')}
      note={t('objects_empty_hint')}
      noMatches={t('objects_no_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export interface ObjectTypesGridProps extends TypeCells {
  types: readonly CatalogType[];
  /** How many types each lens holds, for its option's label. */
  counts: Record<Lens, number>;
}

export function ObjectTypesGrid({ types, counts, ...cellProps }: ObjectTypesGridProps) {
  const { t, language, busy, objectCounts, nameOf, onToggle } = cellProps;
  // Components first, then by id: the list's own order until a header sorts it.
  const rows = useMemo<TypeRow[]>(
    () => [...types].sort(byComponentThenId).map((ct) => ({ ...ct, id: ct.leaf_id })),
    [types]
  );
  const { load, reloadBridge } = useLocalGridLoad(rows, {
    search: (ct) => [ct.leaf_id, nameOf(ct)],
    filter: (ct, filters) => {
      const lens = tagGroupChoice(filters[LENS_FILTER_KEY]) as Lens | null;
      return !lens || inLens(ct, lens);
    },
    compare: {
      component: (a, b) => Number(b.component) - Number(a.component),
      type: (a, b) => nameOf(a).localeCompare(nameOf(b)),
      objects: (a, b) => (objectCounts?.[a.leaf_id]?.count ?? -1) - (objectCounts?.[b.leaf_id]?.count ?? -1),
      namespace: (a, b) => familyOf(a.leaf_id).localeCompare(familyOf(b.leaf_id)),
      id: (a, b) => a.leaf_id.localeCompare(b.leaf_id),
    },
  });

  const columns = useMemo<DataGridTableColumn<TypeRow>[]>(
    () => [
      { id: 'component', label: t('objects_col_component'), component: ComponentCell, width: 112 },
      { id: 'type', label: t('objects_col_type'), component: TypeCell },
      { id: 'objects', label: t('objects_col_objects'), component: ObjectsCell, width: 104 },
      { id: 'namespace', label: t('objects_col_namespace'), component: NamespaceCell },
      { id: 'page', label: t('objects_col_page'), component: PageCell, width: 120 },
      { id: 'id', label: t('objects_col_id'), component: IdCell },
    ],
    [t]
  );
  const lensCounts = LENSES.map((l) => counts[l]).join(',');
  const filters = useMemo(() => {
    const counted = lensCounts.split(',');
    return [
      filterTagGroup({
        id: LENS_FILTER_KEY,
        label: t('objects_lens'),
        mode: 'radio',
        options: LENSES.flatMap((l, at) =>
          l === 'all' ? [] : [{ value: l, label: `${t(`objects_lens_${l}`)} (${counted[at]})` }]
        ),
      }),
    ];
  }, [t, lensCounts]);
  const cells = useMemo<TypeCells>(
    () => ({ t, language, busy, objectCounts, nameOf, onToggle }),
    [t, language, busy, objectCounts, nameOf, onToggle]
  );

  return (
    <TypeCellsProvider value={cells}>
      <ListGrid<TypeRow>
        name="object_types"
        label={t('objects_title')}
        columns={columns}
        load={load}
        search={t('objects_search')}
        filters={filters}
        empty={TypesEmpty}
        unsortable={['page']}
        minWidth="64rem"
      >
        {reloadBridge}
      </ListGrid>
    </TypeCellsProvider>
  );
}
