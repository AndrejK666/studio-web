/**
 * Releases' History step: the project's deploys, newest first, one row each
 * -- what, where, who and when (the prototype's DeployHistory in
 * environments-screen.tsx at 00828880) -- on the kit's DataGrid, the way
 * Specs draws its list (#1076): search, header sort, pages, the portal theme.
 * A click on a row opens what the deploy said under the list -- its reason,
 * its outcome with a crashed container's error -- and asks the cluster how
 * the release is now; a second click closes it. A deploy that installed
 * something can be deployed again from there: a rollback to any earlier
 * build is that (the release map's Deploy stage, 2026-11-24).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Badge, Button, DataGridRowClickPlugin, type DataGridTableColumn } from '@gears-frontx/ui-kit';
import {
  GridClearFilters,
  GridEmpty,
  ListGrid,
  NoData,
  createGridCells,
  useLocalGridLoad,
} from '@constructor-studio/mfe-shared/grid';
import type { Deployment, DeploymentStatus } from '../../api/types';
import { canReadStatus, shortCommit } from '../../model/environments';
import { versionOf } from '../../model/releases';
import { latestByEnvironment } from '../../model/project-deploys';
import { useDeployRequest } from './DeployActions';
import {
  ErrorLine,
  StateBadge,
  When,
  errText,
  personLabel,
  useApi,
  usePeople,
  useReleases,
  type PeopleNames,
  type Text,
} from './parts';
import styles from './ReleasesScreen.module.css';

/** What a cell needs beyond its row. */
interface HistoryCells {
  t: Text;
  people: PeopleNames;
  /** The deploy open under the list, if any. */
  open: string | null;
}

const [HistoryCellsProvider, useHistoryCells] = createGridCells<HistoryCells>('DeployHistory');

const StateCell: React.FC<{ item: Deployment }> = ({ item: d }) => {
  const { open } = useHistoryCells();
  return (
    <span data-deploy-history-row={d.id} data-deploy-history-open={open === d.id || undefined}>
      <StateBadge d={d} />
    </span>
  );
};

const WhatCell: React.FC<{ item: Deployment }> = ({ item: d }) => {
  const { t } = useHistoryCells();
  return (
    <span>
      <b>{d.product}</b>
      {versionOf(d) ? <span className={styles.muted}> · {versionOf(d)}</span> : null}{' '}
      {d.preview && <Badge variant="outline">{t('preview_badge', { name: d.preview.name })}</Badge>}
      {(d.action ?? 'install') === 'uninstall' && <Badge variant="outline">{t('taken_out')}</Badge>}
    </span>
  );
};

const WhereCell: React.FC<{ item: Deployment }> = ({ item: d }) => (
  <span>
    {d.environment_name}{' '}
    <span className={styles.muted}>
      · <code>{d.namespace}</code>
    </span>
  </span>
);

const CommitCell: React.FC<{ item: Deployment }> = ({ item: d }) => {
  const { t } = useHistoryCells();
  return d.commit ? <code>{shortCommit(d.commit)}</code> : <NoData label={t('no_data')} />;
};

const ByCell: React.FC<{ item: Deployment }> = ({ item: d }) => {
  const { t, people } = useHistoryCells();
  return <span>{personLabel(d.requested_by, d.requested_by_name, people, t)}</span>;
};

const WhenCell: React.FC<{ item: Deployment }> = ({ item: d }) => <When iso={d.requested_at} />;

const byText = (pick: (d: Deployment) => string | null | undefined) => (a: Deployment, b: Deployment) =>
  (pick(a) ?? '').localeCompare(pick(b) ?? '', undefined, { sensitivity: 'base', numeric: true });

const HISTORY_OPTIONS = {
  search: (d: Deployment) => [
    d.product,
    d.environment_name,
    d.namespace,
    d.commit,
    d.requested_by_name,
    d.requested_by,
    d.state,
  ],
  compare: {
    state: byText((d) => d.state),
    what: byText((d) => d.product),
    where: byText((d) => d.environment_name),
    by: byText((d) => d.requested_by_name ?? d.requested_by),
    when: byText((d) => d.requested_at),
  },
};

const HistoryEmpty: React.FC = () => {
  const { t } = useHistoryCells();
  return (
    <GridEmpty
      title={t('nothing_deployed')}
      noMatches={t('no_deploys_match')}
      noMatchesActions={<GridClearFilters label={t('clear_search')} />}
    />
  );
};

export function DeployHistory({
  deployments,
  onChanged,
}: {
  deployments: Deployment[];
  /** A deploy asked again from here. */
  onChanged: (message: string) => void;
}) {
  const { t, organizationId, projectId } = useReleases();
  const people = usePeople([organizationId, projectId]);
  const [open, setOpen] = useState<string | null>(null);
  const { load, reloadBridge } = useLocalGridLoad(deployments, HISTORY_OPTIONS);
  const columns = useMemo<DataGridTableColumn<Deployment>[]>(
    () => [
      { id: 'state', label: t('col_state'), component: StateCell, width: 140 },
      { id: 'what', label: t('col_what'), component: WhatCell },
      { id: 'where', label: t('col_where'), component: WhereCell, width: 220 },
      { id: 'commit', label: t('col_commit'), component: CommitCell, width: 110 },
      { id: 'by', label: t('col_by'), component: ByCell, width: 160 },
      { id: 'when', label: t('col_when'), component: WhenCell, width: 120 },
    ],
    [t]
  );
  const toggle = useCallback((d: Deployment) => setOpen((current) => (current === d.id ? null : d.id)), []);
  const opened = deployments.find((d) => d.id === open);
  const cells = useMemo<HistoryCells>(() => ({ t, people, open: opened?.id ?? null }), [t, people, opened]);
  if (deployments.length === 0) return <p className={styles.muted}>{t('nothing_deployed')}</p>;
  return (
    <section className={styles.card} data-deploy-history>
      <HistoryCellsProvider value={cells}>
        <ListGrid<Deployment>
          name="deploy-history"
          label={t('tab_history')}
          columns={columns}
          load={load}
          search={t('search_deploys')}
          empty={HistoryEmpty}
          unsortable={['commit']}
          minWidth="56rem"
        >
          <DataGridRowClickPlugin<Deployment> click={toggle} />
          {reloadBridge}
        </ListGrid>
      </HistoryCellsProvider>
      {opened && (
        <section className={styles.card} data-deploy-history-detail={opened.id}>
          <h3 className={styles.subTitle}>
            {opened.product}
            {versionOf(opened) ? <span className={styles.muted}> · {versionOf(opened)}</span> : null}
            <span className={styles.muted}> · {opened.environment_name}</span>
          </h3>
          <div className={styles.stack}>
            <div className={styles.muted}>
              <When iso={opened.requested_at} /> · {personLabel(opened.requested_by, opened.requested_by_name, people, t)}
            </div>
            {opened.decided_at && (
              <div className={styles.muted}>
                {t(opened.state === 'declined' ? 'declined_by' : 'approved_by', {
                  who: personLabel(opened.decided_by, opened.decided_by_name, people, t),
                })}
              </div>
            )}
            {opened.reason && <div className={styles.muted}>“{opened.reason}”</div>}
            {opened.outcome && <pre className={styles.outcome}>{opened.outcome}</pre>}
            {canReadStatus(opened) && <StatusButton key={opened.id} d={opened} />}
            <DeployAgain key={`again-${opened.id}`} d={opened} deployments={deployments} onChanged={onChanged} />
          </div>
        </section>
      )}
    </section>
  );
}

/** The rollout read back from the cluster, on demand. */
function StatusButton({ d }: { d: Deployment }) {
  const { t, projectId } = useReleases();
  const api = useApi();
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.deploymentStatus({ projectId, id: d.id }).fetch({ staleTime: 0 }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.stack}>
      <span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void read()} data-deployment-status>
          {busy ? t('status_asking') : status ? t('status_again') : t('status_read')}
        </Button>
      </span>
      {error && <ErrorLine>{error}</ErrorLine>}
      {status && (
        <ul className={styles.list}>
          {status.workloads.length === 0 && <li className={styles.muted}>{t('no_workloads', { namespace: d.namespace })}</li>}
          {status.workloads.map((w) => (
            <li key={w.name}>
              <Badge variant={w.ready >= w.desired ? 'success' : 'warning'}>
                {w.ready}/{w.desired}
              </Badge>{' '}
              {w.name} <span className={styles.muted}>{w.images.join(', ')}</span>
            </li>
          ))}
          {(status.problems ?? []).map((p) => (
            <li key={p} className={styles.error} data-deployment-problem>
              {p}
            </li>
          ))}
          {status.hosts.map((h) => (
            <li key={h}>
              <a href={`https://${h}`} target="_blank" rel="noreferrer">
                {h}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Deploy again what a deploy installed, where it installed it: a Research
 *  deploy runs its build's images again (deploy-only), a cluster one installs
 *  the same chart again. Not offered for what runs there now, a preview, a
 *  take-out, or a deploy that did not succeed. */
function DeployAgain({
  d,
  deployments,
  onChanged,
}: {
  d: Deployment;
  deployments: Deployment[];
  onChanged: (message: string) => void;
}) {
  const { t } = useReleases();
  const { busy, error, ask, askBuild } = useDeployRequest(onChanged);
  const current = latestByEnvironment(deployments).get(d.environment_id);
  const installed = d.state === 'succeeded' && (d.action ?? 'install') === 'install' && !d.preview;
  if (!installed || current?.id === d.id) return null;
  const version = versionOf(d) ?? d.product;
  const what = t('what_deploy_to', { version, environment: d.environment_name });
  return (
    <div className={styles.row}>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        title={t('deploy_again_title', { environment: d.environment_name })}
        onClick={() =>
          void (d.research && d.build
            ? askBuild({ id: d.environment_id, kind: 'research' }, d.build, what)
            : ask({ environment_id: d.environment_id, redeploy_of: d.id }, what))
        }
        data-deploy-again={d.id}
      >
        {t('deploy_again', { version })}
      </Button>
      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  );
}
