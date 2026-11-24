/**
 * The Images stage's list on the shared grid (owner feedback, 2026-11-24):
 * one row per image the chosen build made -- the application, the image's
 * name, its tag or digest with Copy, where it lives, when it was built and
 * whether it can run -- with search, header sort and the list's own empty
 * state, as Specs, Workspaces and Gear match draw theirs.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import { GridClearFilters, GridEmpty, ListGrid, NoData, createGridCells, useLocalGridLoad } from '@constructor-studio/mfe-shared/grid';
import type { ProjectImage, ResearchBuildImage } from '../../api/types';
import type { IdeBuild } from '../../model/builds';
import { imageRows, type ImageRow, type ImageStatus } from '../../model/image-rows';
import { TargetIcon } from './Targets';
import { When, useApi, useReleases, type Text } from './parts';
import styles from './ReleasesScreen.module.css';

const STATUS_BADGE: Record<ImageStatus, 'success' | 'info' | 'danger' | 'warning' | 'secondary'> = {
  ready: 'success',
  building: 'info',
  failed: 'danger',
  unconfirmed: 'warning',
  gone: 'secondary',
};

interface ImageCells {
  t: Text;
}

const [ImageCellsProvider, useImageCells] = createGridCells<ImageCells>('BuildImages');

const AppCell: React.FC<{ item: ImageRow }> = ({ item }) => (
  <b data-build-image={item.app}>{item.app}</b>
);

const NameCell: React.FC<{ item: ImageRow }> = ({ item }) => <code>{item.name}</code>;

const VersionCell: React.FC<{ item: ImageRow }> = ({ item }) => {
  const { t } = useImageCells();
  const [copied, setCopied] = useState(false);
  if (!item.version) return <NoData label={t('no_data')} />;
  return (
    <span className={styles.chips}>
      <code title={item.version}>{item.versionShort}</code>
      <Button
        size="sm"
        variant="ghost"
        title={t('image_copy_title', { reference: item.reference })}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(item.reference).then(() => setCopied(true), () => undefined);
        }}
        data-image-copy={item.app}
      >
        {t(copied ? 'image_copied' : 'image_copy')}
      </Button>
    </span>
  );
};

const PlaceCell: React.FC<{ item: ImageRow }> = ({ item }) => {
  const { t } = useImageCells();
  return (
    <span className={styles.targetMain} data-image-place={item.place}>
      <TargetIcon kind={item.place === 'research' ? 'research' : 'kubernetes'} />
      {item.place === 'research'
        ? t('image_place_research')
        : item.host
          ? t('image_place_registry', { host: item.host })
          : t('map_images_in_default_registry')}
    </span>
  );
};

const BuiltCell: React.FC<{ item: ImageRow }> = ({ item }) => {
  const { t } = useImageCells();
  return item.builtAt ? <When iso={item.builtAt} /> : <NoData label={t('no_data')} />;
};

const StatusCell: React.FC<{ item: ImageRow }> = ({ item }) => {
  const { t } = useImageCells();
  return (
    <Badge
      variant={STATUS_BADGE[item.status]}
      title={item.message ?? t(`image_status_${item.status}_title`)}
      data-image-status={item.status}
    >
      {t(`image_status_${item.status}`)}
    </Badge>
  );
};

const byText = (pick: (r: ImageRow) => string | null) => (a: ImageRow, b: ImageRow) =>
  (pick(a) ?? '').localeCompare(pick(b) ?? '', undefined, { sensitivity: 'base', numeric: true });

const IMAGE_OPTIONS = {
  search: (r: ImageRow) => [r.app, r.name, r.version, r.reference, r.host],
  compare: {
    app: byText((r) => r.app),
    name: byText((r) => r.name),
    place: byText((r) => r.host ?? r.place),
    built: byText((r) => r.builtAt),
    status: byText((r) => r.status),
  },
};

const ImagesEmpty: React.FC = () => {
  const { t } = useImageCells();
  return (
    <GridEmpty
      title={t('images_none_made')}
      noMatches={t('no_images_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

/** The images `build` made, joined with what Studio recorded of them in a registry. */
export function ImagesGrid({ build }: { build: IdeBuild }) {
  const { t, projectId } = useReleases();
  const api = useApi();
  const [records, setRecords] = useState<ProjectImage[]>([]);
  useEffect(() => {
    // Research keeps its own images: Studio records only what a registry holds.
    if (build.where === 'research') return;
    let live = true;
    api
      .buildImages({ projectId, buildId: build.buildId })
      .fetch({ staleTime: 0 })
      .then((page) => live && setRecords(page.items))
      .catch(() => live && setRecords([]));
    return () => {
      live = false;
    };
  }, [api, projectId, build.buildId, build.where]);
  // A Research build's images: what Research says of each, now.
  const [research, setResearch] = useState<ResearchBuildImage[] | null | undefined>(undefined);
  useEffect(() => {
    setResearch(undefined);
    if (build.where !== 'research') return;
    let live = true;
    api
      .researchBuildImages({ projectId, buildId: build.buildId })
      .fetch({ staleTime: 0 })
      .then((page) => live && setResearch(page.items))
      .catch(() => live && setResearch(null));
    return () => {
      live = false;
    };
  }, [api, projectId, build.buildId, build.where]);
  const rows = useMemo(
    () => (build.where === 'research' ? imageRows(build, [], research) : imageRows(build, records)),
    [build, records, research]
  );
  const { load, reloadBridge } = useLocalGridLoad(rows, IMAGE_OPTIONS);
  const columns = useMemo<DataGridTableColumn<ImageRow>[]>(
    () => [
      { id: 'app', label: t('col_application'), component: AppCell, width: 220 },
      { id: 'name', label: t('col_image'), component: NameCell },
      { id: 'version', label: t('col_version'), component: VersionCell, width: 230 },
      { id: 'place', label: t('col_lives_in'), component: PlaceCell, width: 220 },
      { id: 'built', label: t('col_built'), component: BuiltCell, width: 130 },
      { id: 'status', label: t('col_status'), component: StatusCell, width: 130 },
    ],
    [t]
  );
  const cells = useMemo<ImageCells>(() => ({ t }), [t]);
  return (
    <ImageCellsProvider value={cells}>
      <div data-build-images>
        <ListGrid<ImageRow>
          name="build-images"
          label={t('stage_images')}
          columns={columns}
          load={load}
          search={t('search_images')}
          empty={ImagesEmpty}
          unsortable={['version']}
          defaultOrder={{ id: 'app', direction: 'asc' }}
          minWidth="56rem"
        >
          {reloadBridge}
        </ListGrid>
      </div>
    </ImageCellsProvider>
  );
}
