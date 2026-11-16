/**
 * A component as the Kits screens draw a kit (#1081): its type as a glyph and
 * a word, and a tile for the grid's tiles view — icon, name, type, state, one
 * line of purpose, and the projects using it. The view the person chose is
 * kept in `/me/ui-preferences` (`mfe.components.view`), as Kits keeps its own.
 */

import React, { useEffect } from 'react';
import {
  DATA_GRID_VIEW,
  createDataGridPlugin,
  useDataGrid,
  useDataGridActiveView,
} from '@gears-frontx/ui-kit';
import { LayoutGrid } from 'lucide-react';
import { ComponentTypeIcon, useHostPreference, type ComponentType } from '@constructor-studio/mfe-shared';
import type { ChildMfeBridge } from '@gears-frontx/react';
import type { Text } from './common';
import styles from './ComponentView.module.css';

/** Where the person's choice of view is kept, and the tiles view's value of it. */
export const COMPONENTS_VIEW_PREFERENCE = 'mfe.components.view';
export const COMPONENTS_VIEW_TILES = 'tiles';

/** The type's word, as the list and the page say it. */
export function typeLabel(type: ComponentType, t: Text): string {
  return t(`type_${type}`);
}

/** The type as a glyph and a word; a plugin names the gear it plugs into when known. */
export function TypeBadge({
  type,
  t,
  reason,
  hosts,
  large,
}: {
  type: ComponentType;
  t: Text;
  reason?: string | null;
  hosts?: readonly string[];
  large?: boolean;
}) {
  const of = type === 'plugin' && hosts && hosts.length > 0 ? hosts.join(', ') : null;
  return (
    <span className={`${styles.type} ${large ? styles.typeLarge : ''}`} data-component-type={type} title={reason ?? undefined}>
      <ComponentTypeIcon type={type} className={styles.typeIcon} size={large ? 18 : 14} />
      <span>{of ? t('type_plugin_of', { host: of }) : typeLabel(type, t)}</span>
    </span>
  );
}

/** What a tile shows of one row. */
export interface TileFacts {
  key: string;
  name: string;
  type: ComponentType;
  state: React.ReactNode;
  purpose: string;
  projects: string[];
}

/** One component as a card. */
export function ComponentTile({ tile, t, onOpen }: { tile: TileFacts; t: Text; onOpen: () => void }) {
  return (
    <li className={styles.tile} data-component-tile={tile.name}>
      <h3 className={styles.tileTitle}>
        <ComponentTypeIcon type={tile.type} className={styles.tileIcon} size={20} />
        <button type="button" className={styles.tileLink} onClick={onOpen}>
          {tile.name}
        </button>
      </h3>
      <div className={styles.tileMeta}>
        <TypeBadge type={tile.type} t={t} />
        {tile.state}
      </div>
      <p className={styles.tilePurpose}>{tile.purpose || <span className={styles.muted}>{t('no_purpose')}</span>}</p>
      <p className={styles.tileProjects}>
        {tile.projects.length > 0 ? t('used_in', { projects: tile.projects.join(', ') }) : <span className={styles.muted}>{t('used_in_none')}</span>}
      </p>
      <button type="button" className={styles.inside} onClick={onOpen}>
        {t('inside')}
      </button>
    </li>
  );
}

const TilesIcon: React.FC = () => <LayoutGrid aria-hidden="true" />;

/**
 * The tiles as a grid's second main view (the grid draws the table/tiles
 * switch itself): `Tiles` reads the grid's visible records.
 */
export function tilesPlugin(name: string, Tiles: React.FC) {
  return createDataGridPlugin(name, (context) => {
    context.registerSlot('main', { id: DATA_GRID_VIEW.cards, component: Tiles, icon: TilesIcon });
    return {};
  });
}

/** The visible rows of the grid a tiles view is in. */
export function useVisibleRows<Row>(): Row[] {
  return useDataGrid()
    .useStore((state) => state.visibleRecords)
    .map((record) => record.item as unknown as Row);
}

/**
 * Keeps the grid's view and the person's preference in step: the preference
 * picks the view when it arrives, a click on the switch writes it.
 */
export const ViewFromPreference: React.FC<{ bridge: ChildMfeBridge }> = ({ bridge }) => {
  const grid = useDataGrid();
  const active = useDataGridActiveView();
  const [stored, store] = useHostPreference(COMPONENTS_VIEW_PREFERENCE, { bridge });
  const tiles = stored === COMPONENTS_VIEW_TILES;
  useEffect(() => {
    const view = tiles ? DATA_GRID_VIEW.cards : DATA_GRID_VIEW.table;
    if (grid.getActiveSlotId('main') !== view) grid.setActiveSlotId('main', view);
  }, [grid, tiles]);
  useEffect(() => {
    const now = grid.getActiveSlotId('main');
    if (!active || !now) return;
    const nowTiles = now === DATA_GRID_VIEW.cards;
    // The table is the default: choosing it again forgets the choice.
    if (nowTiles !== tiles) store(nowTiles ? COMPONENTS_VIEW_TILES : '');
  }, [grid, active, tiles, store]);
  return null;
};
