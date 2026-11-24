/**
 * The Environment stage's list on the shared grid (owner feedback,
 * 2026-11-24): every environment the project may deploy to, Kubernetes and
 * Constructor Research alike, one row each -- where it runs, how its newest
 * deploy went, what runs there, whether the chosen images can go there, and
 * Choose. Where it runs and whether it takes the chosen images are filters,
 * kept in the address (`rel.envs.f.kind`, `rel.envs.f.fits`), so the Images
 * stage can open this list on the environments its images can go to.
 */

import React, { useCallback, useMemo } from 'react';
import {
  Badge,
  Button,
  DataGridRowClickPlugin,
  filterTagGroup,
  type DataGridLoadContext,
  type DataGridTableColumn,
} from '@gears-frontx/ui-kit';
import {
  GridAddress,
  GridClearFilters,
  GridEmpty,
  ListGrid,
  createGridCells,
  pageOfRows,
  shownRows,
  tagGroupChoice,
  useLocalGridReload,
  writeGridAddress,
} from '@constructor-studio/mfe-shared/grid';
import { byTargetKind, targetKindOf, type TargetKind, type TargetNames } from '../../model/environment-targets';
import type { FitGap } from '../../model/release-map';
import { productUrls } from '../../model/project-deploys';
import { stepStatus, versionOf, type LadderStep } from '../../model/releases';
import { TargetCell, TargetIcon } from './Targets';
import { TONE_BADGE, When, useReleases, type Text, type Tone } from './parts';
import styles from './ReleasesScreen.module.css';

/** Where the list's filters live in the address. */
export const ENVIRONMENTS_ADDRESS = 'rel.envs.';
const ADDRESS_FILTERS = ['kind', 'fits'] as const;

export interface EnvironmentRow {
  id: string;
  step: LadderStep;
  kind: TargetKind;
  /** Whether the chosen images can go there: `none` while no images are chosen. */
  fit: FitGap | 'none';
}

/** A ladder step's tone (releases.ts) as a chip's. */
const LADDER_TONE: Record<ReturnType<typeof stepStatus>['tone'], Tone> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'danger',
  idle: 'neutral',
};

interface EnvironmentCells {
  t: Text;
  names: TargetNames;
  selected: string | null;
  blocked: string | null;
  onSelect: (environment: string) => void;
  /** The build whose images are chosen, for the fit's words. */
  build: string | null;
}

const [EnvironmentCellsProvider, useEnvironmentCells] = createGridCells<EnvironmentCells>('Environments');

const NameCell: React.FC<{ item: EnvironmentRow }> = ({ item: { step: s } }) => {
  const { t, selected } = useEnvironmentCells();
  return (
    <span
      className={styles.stackTight}
      data-ladder-row={s.environment.name}
      data-ladder-step={s.environment.name}
      data-ladder-state={s.state}
      data-ladder-selected={selected === s.environment.id || undefined}
    >
      <span className={styles.chips}>
        <b>{s.environment.name}</b>
        {s.environment.protected && <Badge variant="info">{t('needs_approval')}</Badge>}
        {s.environment.project_id && (
          <Badge variant="secondary" data-own-environment>
            {t('projects_own')}
          </Badge>
        )}
      </span>
      {s.from && <span className={styles.muted}>{t('takes_from', { environment: s.from })}</span>}
    </span>
  );
};

const KindCell: React.FC<{ item: EnvironmentRow }> = ({ item }) => {
  const { t } = useEnvironmentCells();
  return (
    <span className={styles.targetMain} data-environment-kind={item.kind}>
      <TargetIcon kind={item.kind} />
      {t(`target_kind_${item.kind}`)}
    </span>
  );
};

const TargetColumnCell: React.FC<{ item: EnvironmentRow }> = ({ item: { step: s } }) => {
  const { names } = useEnvironmentCells();
  return <TargetCell env={s.environment} namespace={s.namespace} names={names} />;
};

const StatusCell: React.FC<{ item: EnvironmentRow }> = ({ item: { step: s } }) => {
  const status = stepStatus(s);
  return (
    <Badge
      className={styles.wrapBadge}
      variant={TONE_BADGE[s.state === 'deploying' ? 'running' : LADDER_TONE[status.tone]]}
      data-ladder-status
    >
      {status.text}
    </Badge>
  );
};

const RunsCell: React.FC<{ item: EnvironmentRow }> = ({ item: { step: s } }) => {
  const { t } = useEnvironmentCells();
  if (!s.runs) return <span className={styles.muted}>{t('nothing')}</span>;
  return (
    <span className={styles.stackTight}>
      <code>{versionOf(s.runs) ?? s.runs.product}</code>
      {productUrls(s.runs.outcome).map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} data-product-url>
          {t('open_product')}
        </a>
      ))}
    </span>
  );
};

const FitCell: React.FC<{ item: EnvironmentRow }> = ({ item }) => {
  const { t, build } = useEnvironmentCells();
  if (item.fit === 'none') return <span className={styles.muted}>—</span>;
  return (
    <Badge
      className={styles.wrapBadge}
      variant={item.fit === null ? 'success' : item.fit === 'promotion' ? 'warning' : 'secondary'}
      data-ladder-fit={item.fit ?? 'yes'}
    >
      {item.fit === null ? t('fits_yes', { build: build ?? '' }) : t(`map_gap_${item.fit}`)}
    </Badge>
  );
};

const LastDeployCell: React.FC<{ item: EnvironmentRow }> = ({ item }) => <When iso={item.step.latest?.requested_at} />;

const ChooseCell: React.FC<{ item: EnvironmentRow }> = ({ item }) => {
  const { t, selected, blocked, onSelect } = useEnvironmentCells();
  const chosen = selected === item.id;
  return (
    <Button
      size="sm"
      variant={chosen ? 'default' : 'outline'}
      aria-pressed={chosen}
      disabled={!!blocked}
      title={blocked ?? t('choose_environment_title')}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(item.id);
      }}
      data-ladder-choose
    >
      {t(chosen ? 'environment_chosen' : 'choose_environment')}
    </Button>
  );
};

const byText = (pick: (r: EnvironmentRow) => string | null | undefined) => (a: EnvironmentRow, b: EnvironmentRow) =>
  (pick(a) ?? '').localeCompare(pick(b) ?? '', undefined, { sensitivity: 'base', numeric: true });

const STATE_ORDER: Record<LadderStep['state'], string> = {
  failed: '0',
  deploying: '1',
  waiting: '2',
  runs: '3',
  removed: '4',
  empty: '5',
};

/** The rows a filter keeps: where it runs, and whether it takes the chosen images. */
function keeps(row: EnvironmentRow, filters: NonNullable<DataGridLoadContext['filters']>): boolean {
  const kind = tagGroupChoice(filters.kind as { value?: unknown } | undefined);
  const fits = tagGroupChoice(filters.fits as { value?: unknown } | undefined);
  return (!kind || row.kind === kind) && (!fits || row.fit === null);
}

const OPTIONS = {
  search: (r: EnvironmentRow) => [
    r.step.environment.name,
    r.step.namespace,
    r.step.environment.research_project,
    r.step.runs ? versionOf(r.step.runs) : null,
  ],
  filter: keeps,
  compare: {
    environment: byText((r) => r.step.environment.name),
    kind: byText((r) => r.kind),
    status: byText((r) => STATE_ORDER[r.step.state]),
    last_deploy: byText((r) => r.step.latest?.requested_at),
  },
};

const EnvironmentsEmpty: React.FC = () => {
  const { t } = useEnvironmentCells();
  return (
    <GridEmpty
      title={t('environments_none')}
      noMatches={t('no_environments_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

/** The project's environments, Kubernetes ones first, each in the ladder's order. */
export function environmentRows(
  steps: readonly LadderStep[],
  fit: (step: LadderStep) => FitGap | 'none'
): EnvironmentRow[] {
  const groups = byTargetKind(steps, (step) => step.environment);
  return [...groups.kubernetes, ...groups.research].map((step) => ({
    id: step.environment.id,
    step,
    kind: targetKindOf(step.environment),
    fit: fit(step),
  }));
}

export function EnvironmentsGrid({
  rows,
  names,
  selected,
  blocked,
  build,
  onSelect,
}: {
  rows: EnvironmentRow[];
  names: TargetNames;
  selected: string | null;
  /** Why nothing can be deployed yet (no product): Choose waits, saying so. */
  blocked: string | null;
  build: string | null;
  onSelect: (environment: string) => void;
}) {
  const { t } = useReleases();
  const reloadBridge = useLocalGridReload(rows);
  // The grid keeps `load` for its life: it reads the rows through a ref the reload bridge follows.
  const current = React.useRef(rows);
  React.useLayoutEffect(() => {
    current.current = rows;
  });
  const load = useCallback(async (context: DataGridLoadContext) => {
    writeGridAddress(context, ENVIRONMENTS_ADDRESS, ADDRESS_FILTERS);
    return pageOfRows(shownRows(current.current, context, OPTIONS), context);
  }, []);
  const columns = useMemo<DataGridTableColumn<EnvironmentRow>[]>(
    () => [
      { id: 'environment', label: t('col_environment'), component: NameCell, width: 220 },
      { id: 'kind', label: t('col_kind'), component: KindCell, width: 110 },
      { id: 'target', label: t('col_target'), component: TargetColumnCell, width: 240 },
      { id: 'status', label: t('col_status'), component: StatusCell, width: 190 },
      { id: 'runs', label: t('col_runs'), component: RunsCell, width: 140 },
      { id: 'fits', label: t('col_fits'), component: FitCell, width: 190 },
      { id: 'last_deploy', label: t('col_last_deploy'), component: LastDeployCell, width: 110 },
      { id: 'choose', label: '', component: ChooseCell, width: 100 },
    ],
    [t]
  );
  const filters = useMemo(
    () => [
      filterTagGroup({
        id: 'kind',
        label: t('col_kind'),
        mode: 'radio',
        options: [
          { value: 'kubernetes', label: t('target_kind_kubernetes') },
          { value: 'research', label: t('target_kind_research') },
        ],
      }),
      filterTagGroup({
        id: 'fits',
        label: t('col_fits'),
        mode: 'radio',
        options: [{ value: 'yes', label: t('filter_fits') }],
      }),
    ],
    [t]
  );
  const cells = useMemo<EnvironmentCells>(
    () => ({ t, names, selected, blocked, onSelect, build }),
    [t, names, selected, blocked, onSelect, build]
  );
  const click = useCallback((row: EnvironmentRow) => !blocked && onSelect(row.id), [blocked, onSelect]);
  return (
    <EnvironmentCellsProvider value={cells}>
      <div data-environments-grid>
        <ListGrid<EnvironmentRow>
          name="environments"
          label={t('stage_environment')}
          columns={columns}
          load={load}
          search={t('search_environments')}
          filters={filters}
          empty={EnvironmentsEmpty}
          unsortable={['target', 'runs', 'fits', 'choose']}
          minWidth="72rem"
        >
          <DataGridRowClickPlugin<EnvironmentRow> click={click} />
          <GridAddress prefix={ENVIRONMENTS_ADDRESS} filterKeys={ADDRESS_FILTERS} />
          {reloadBridge}
        </ListGrid>
      </div>
    </EnvironmentCellsProvider>
  );
}
