/**
 * What a kit adds to the model (#1099): its types and the types of the model
 * they relate to, as a small diagram with the relation names on the edges.
 * Selecting a type lists its fields and where each comes from. A kit with
 * more types than the diagram holds says so, and the list view (on the
 * shared grid) has every one.
 */

import React, { useMemo, useState } from 'react';
import { Badge, Button } from '@gears-frontx/ui-kit';
import type { DataGridTableColumn } from '@gears-frontx/ui-kit';
import { GridEmpty, ListGrid, useLocalGridLoad } from '@constructor-studio/mfe-shared/grid';
import { layoutDiagram, type ModelGraph, type ModelNode } from '../../../model/kitPage';
import { ItemsGrid, type ItemRow } from './ItemsGrid';
import type { Text } from './text';
import styles from './KitPage.module.css';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const ModelDiagram: React.FC<{ graph: ModelGraph; t: Text }> = ({ graph, t }) => {
  const layout = useMemo(() => layoutDiagram(graph), [graph]);
  const [view, setView] = useState<'diagram' | 'list'>(layout.hidden > 0 ? 'list' : 'diagram');
  const [selected, setSelected] = useState<string | null>(graph.nodes.find((n) => n.kit)?.id ?? null);
  const node = graph.nodes.find((n) => n.id === selected) ?? null;

  const choose = (id: string) => setSelected(id);
  const onKey = (event: React.KeyboardEvent, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(id);
    }
  };

  return (
    <div className={styles.panel} data-model-diagram>
      <div className={styles.row} role="group" aria-label={t('model_view')}>
        <Button
          size="sm"
          variant={view === 'diagram' ? 'secondary' : 'ghost'}
          aria-pressed={view === 'diagram'}
          onClick={() => setView('diagram')}
        >
          {t('model_view_diagram')}
        </Button>
        <Button
          size="sm"
          variant={view === 'list' ? 'secondary' : 'ghost'}
          aria-pressed={view === 'list'}
          onClick={() => setView('list')}
        >
          {t('model_view_list')}
        </Button>
        {layout.hidden > 0 && view === 'diagram' && (
          <span className={styles.note}>{t('model_more', { count: layout.hidden })}</span>
        )}
      </div>
      {view === 'diagram' ? (
        <svg
          className={styles.diagram}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={t('model_diagram_label')}
        >
          {layout.edges.map((e) => (
            <g key={`${e.from}→${e.to}`} data-edge={`${e.from}→${e.to}`}>
              <path className={styles.edge} d={e.path} />
              <text className={styles.edgeLabel} x={e.lx} y={e.ly} textAnchor="middle" dominantBaseline="middle">
                <title>{e.labels.join(', ')}</title>
                {clip(e.labels.join(', '), 24)}
              </text>
            </g>
          ))}
          {layout.nodes.map((n) => (
            <g
              key={n.id}
              className={`${styles.node} ${n.kit ? styles.nodeKit : ''}`}
              transform={`translate(${n.x} ${n.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={n.id === selected}
              aria-label={`${n.label}${n.kit ? '' : ` (${t('model_core_type')})`}`}
              data-model-node={n.id}
              onClick={() => choose(n.id)}
              onKeyDown={(event) => onKey(event, n.id)}
            >
              <rect width={n.w} height={n.h} rx={6} />
              <text x={10} y={n.h / 2} dominantBaseline="middle">
                {clip(n.label, 22)}
              </text>
            </g>
          ))}
        </svg>
      ) : (
        <TypeList graph={graph} selected={selected} choose={choose} t={t} />
      )}
      {node && <TypeFields node={node} graph={graph} t={t} />}
    </div>
  );
};

ModelDiagram.displayName = 'ModelDiagram';

interface TypeRow {
  id: string;
  name: string;
  origin: string;
  fields: number;
  relations: number;
}

/** Module-level and keyed by the text function: the grid takes stable components. */
const TypeListCtx = React.createContext<{ t: Text; choose: (id: string) => void; selected: string | null } | null>(
  null
);

const NameCell: React.FC<{ item: TypeRow }> = ({ item }) => {
  const ctx = React.useContext(TypeListCtx);
  return (
    <button
      type="button"
      className={styles.linkButton}
      aria-pressed={ctx?.selected === item.id}
      data-model-row={item.id}
      onClick={() => ctx?.choose(item.id)}
    >
      {item.name}
    </button>
  );
};

const TypesEmpty: React.FC = () => {
  const ctx = React.useContext(TypeListCtx);
  return <GridEmpty noMatches={ctx?.t('model_none') ?? ''} title={ctx?.t('model_none')} />;
};

const TypeList: React.FC<{
  graph: ModelGraph;
  selected: string | null;
  choose: (id: string) => void;
  t: Text;
}> = ({ graph, selected, choose, t }) => {
  const rows = useMemo<TypeRow[]>(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        name: n.label,
        origin: n.kit ? (n.adopts ? t('model_adopts') : t('model_new')) : t('model_core_type'),
        fields: n.fields.length,
        relations: graph.edges.filter((e) => e.from === n.id || e.to === n.id).length,
      })),
    [graph, t]
  );
  const { load, reloadBridge } = useLocalGridLoad(rows, {
    search: (row) => [row.name, row.id],
  });
  const columns = useMemo<DataGridTableColumn<TypeRow>[]>(
    () => [
      { id: 'name', label: t('model_col_type'), component: NameCell },
      { id: 'origin', label: t('model_col_origin'), width: 200 },
      { id: 'fields', label: t('model_col_fields'), width: 100 },
      { id: 'relations', label: t('model_col_relations'), width: 120 },
    ],
    [t]
  );
  return (
    <TypeListCtx.Provider value={{ t, choose, selected }}>
      <ListGrid<TypeRow>
        name="kit-model-types"
        label={t('model_view_list')}
        columns={columns}
        load={load}
        search={t('model_search')}
        empty={TypesEmpty}
        unsortable={['name', 'origin', 'fields', 'relations']}
      >
        {reloadBridge}
      </ListGrid>
    </TypeListCtx.Provider>
  );
};

const TypeFields: React.FC<{ node: ModelNode; graph: ModelGraph; t: Text }> = ({ node, graph, t }) => {
  const relations = graph.edges.filter((e) => e.from === node.id || e.to === node.id);
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const rows = useMemo<ItemRow[]>(() => {
    const origin = (o: string) =>
      node.kit ? (o === 'core' ? t('field_origin_core') : t('field_origin_kit')) : t('field_origin_added');
    return node.fields.map((f, i) => ({
      id: `${f.origin}:${f.name}:${i}`,
      kind: origin(f.origin),
      name: `${f.name}${f.required ? ' *' : ''}`,
      note: f.description ? `${f.type} — ${f.description}` : f.type,
    }));
  }, [node, t]);
  return (
    <section className={styles.panel} aria-live="polite" data-type-fields={node.id}>
      <div className={styles.row}>
        <b>{node.label}</b>
        <code className={styles.mono}>{node.id}</code>
        <Badge variant={node.kit ? 'info' : 'outline'}>
          {node.kit ? (node.adopts ? t('model_adopts') : t('model_new')) : t('model_core_type')}
        </Badge>
      </div>
      {node.description && <p className={styles.note}>{node.description}</p>}
      {node.fields.length === 0 ? (
        <p className={styles.note}>{t('model_no_fields')}</p>
      ) : (
        <ItemsGrid
          key={node.id}
          name="kit-type-fields"
          label={t('model_fields_of', { type: node.label })}
          rows={rows}
          t={t}
          headings={[t('model_field_origin'), t('model_field'), t('model_field_type')]}
          asDeclared
        />
      )}
      {relations.length > 0 && (
        <p className={styles.note}>
          {t('model_relations', {
            list: relations
              .map((e) => (e.from === node.id ? `${e.labels.join(', ')} → ${name(e.to)}` : `${name(e.from)} → ${e.labels.join(', ')}`))
              .join('; '),
          })}
        </p>
      )}
    </section>
  );
};
