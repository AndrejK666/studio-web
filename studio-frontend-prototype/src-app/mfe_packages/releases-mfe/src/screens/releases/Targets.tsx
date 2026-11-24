/**
 * Where each environment runs (owner feedback, 2026-11-23): Releases splits
 * its environments into Kubernetes -- namespaces of the organization's
 * clusters, deployed to with Deploy… -- and Constructor Research --
 * applications in Research projects, built and run with Build and run in
 * Research -- and names the place on every row: the cluster and namespace,
 * or the Research project, its hardware and the Research account. The groups
 * are the release map's Environment stage: a row's Choose picks where the
 * chosen images go.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { Connection, DeployEnvironment, PathAction, ProjectPath, ResearchHardware, ResearchProject } from '../../api/types';
import {
  byTargetKind,
  environmentTarget,
  researchProjectsWithHardware,
  type TargetKind,
  type TargetNames,
} from '../../model/environment-targets';
import type { Intent } from '../../model/path';
import type { LadderStep } from '../../model/releases';
import { ReleaseLadder } from './Ladder';
import { ActionButton } from './ProjectPath';
import { useApi, useReleases } from './parts';
import styles from './ReleasesScreen.module.css';

/** The names the rows need: the project's connections, and -- signed in to
 *  Research with the kit -- the caller's Research projects and the hardware
 *  of those an environment names hardware in. Every read may fail: a row
 *  then shows the id it has. */
export function useTargetNames(environments: readonly DeployEnvironment[], path: ProjectPath | null): TargetNames {
  const { projectId } = useReleases();
  const api = useApi();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [hardware, setHardware] = useState<Map<string, ResearchHardware[]>>(new Map());
  const signIn = path?.research?.state;
  const research = !!path?.research_kit && (signIn === 'signed_in' || signIn === 'runs_out');
  const anyResearch = environments.some((e) => e.kind === 'research');
  const withHardware = researchProjectsWithHardware(environments).join(',');

  useEffect(() => {
    let live = true;
    api
      .connections({ tenantId: projectId })
      .fetch({ staleTime: 60_000 })
      .then((r) => live && setConnections(r.items))
      .catch(() => live && setConnections([]));
    return () => {
      live = false;
    };
  }, [api, projectId]);

  useEffect(() => {
    if (!research || !anyResearch) return;
    let live = true;
    api
      .myResearchProjects({ projectId })
      .fetch({ staleTime: 60_000 })
      .then((r) => live && setProjects(r.items))
      .catch(() => live && setProjects([]));
    return () => {
      live = false;
    };
  }, [api, projectId, research, anyResearch]);

  useEffect(() => {
    // Only the Research projects the caller's sign-in lists can be asked.
    const ids = withHardware.split(',').filter((id) => id && projects.some((p) => p.id === id));
    if (!research || ids.length === 0) return;
    let live = true;
    void Promise.all(
      ids.map((id) =>
        api
          .myResearchHardware({ projectId, researchProject: id })
          .fetch({ staleTime: 60_000 })
          .then((r) => [id, r.items] as const)
          .catch(() => [id, [] as ResearchHardware[]] as const)
      )
    ).then((pairs) => live && setHardware(new Map(pairs)));
    return () => {
      live = false;
    };
  }, [api, projectId, research, withHardware, projects]);

  return useMemo(() => ({ connections, researchProjects: projects, hardware }), [connections, projects, hardware]);
}

/** A cluster or a Research flask, in the text's colour. */
export function TargetIcon({ kind }: { kind: TargetKind }) {
  return (
    <svg className={styles.targetIcon} viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false" data-target-icon={kind}>
      {kind === 'kubernetes' ? (
        // Three stacked servers: a cluster's nodes.
        <g fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="2" y="2" width="12" height="3.2" rx="0.8" />
          <rect x="2" y="6.4" width="12" height="3.2" rx="0.8" />
          <rect x="2" y="10.8" width="12" height="3.2" rx="0.8" />
          <circle cx="4.4" cy="3.6" r="0.5" fill="currentColor" />
          <circle cx="4.4" cy="8" r="0.5" fill="currentColor" />
          <circle cx="4.4" cy="12.4" r="0.5" fill="currentColor" />
        </g>
      ) : (
        // A flask: research.
        <path
          d="M6 1.8h4M6.8 1.8v4.4L2.9 12.7a1.1 1.1 0 0 0 .95 1.6h8.3a1.1 1.1 0 0 0 .95-1.6L9.2 6.2V1.8M4.6 10h6.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** Where one environment runs, as a row's cell. */
export function TargetCell({ env, namespace, names }: { env: DeployEnvironment; namespace: string; names: TargetNames }) {
  const { t } = useReleases();
  const target = environmentTarget(env, namespace, names);
  if (target.kind === 'kubernetes') {
    return (
      <span className={styles.targetCell} data-environment-target="kubernetes">
        <span className={styles.targetMain}>
          <TargetIcon kind="kubernetes" />
          <b title={t('target_cluster')}>{target.cluster ?? t('target_cluster_unknown')}</b>
        </span>
        <span className={styles.muted}>
          {t('target_namespace')} <code>{target.namespace}</code>
        </span>
      </span>
    );
  }
  return (
    <span className={styles.targetCell} data-environment-target="research">
      <span className={styles.targetMain}>
        <TargetIcon kind="research" />
        <b title={target.projectNamed ? t('target_research_project') : t('target_not_yours')}>{target.project ?? '—'}</b>
      </span>
      <span className={styles.muted}>
        {t('target_hardware')}: {target.hardware ?? t('target_hardware_default')}
        {target.account && (
          <>
            {' · '}
            {t('target_account')}: {target.account}
          </>
        )}
      </span>
    </span>
  );
}

/** One group's heading: its icon, its name, what it is, and its action. */
function GroupHead({
  kind,
  about,
  action,
}: {
  kind: TargetKind;
  about: string;
  action?: React.ReactNode;
}) {
  const { t } = useReleases();
  return (
    <div className={styles.groupHead} data-environment-group-head>
      <span className={styles.groupIcon} data-group-icon={kind}>
        <TargetIcon kind={kind} />
      </span>
      <span className={styles.groupText}>
        <h3 className={styles.subTitle}>{t(kind === 'kubernetes' ? 'group_kubernetes' : 'group_research')}</h3>
        <span className={styles.muted}>{about}</span>
      </span>
      {action && <span data-environment-group-action>{action}</span>}
    </div>
  );
}

type LadderProps = Pick<React.ComponentProps<typeof ReleaseLadder>, 'bindings' | 'selected' | 'onSelect' | 'fitOf'>;

/** The environments in two groups, each with its place and its action. */
export function EnvironmentGroups({
  steps,
  path,
  names,
  blocked,
  noEnvironment,
  ...ladder
}: LadderProps & {
  steps: LadderStep[];
  path: ProjectPath | null;
  names: TargetNames;
  /** Why nothing can be built or deployed yet (no product); null: it can. */
  blocked: string | null;
  /** What the Kubernetes group says with no cluster environment. */
  noEnvironment: React.ReactNode;
}) {
  const { t } = useReleases();
  const groups = byTargetKind(steps, (s) => s.environment);
  const kit = !!path?.research_kit;
  const targetOf = (s: LadderStep) => <TargetCell env={s.environment} namespace={s.namespace} names={names} />;
  return (
    <>
      <div data-environment-group="kubernetes">
        <ReleaseLadder
          {...ladder}
          steps={groups.kubernetes}
          targetOf={targetOf}
          blocked={blocked}
          head={
            <>
              <GroupHead kind="kubernetes" about={t('group_kubernetes_about')} />
              {groups.kubernetes.length === 0 && noEnvironment}
            </>
          }
        />
      </div>
      {(kit || groups.research.length > 0) && (
        <div data-environment-group="research">
          <ReleaseLadder
            {...ladder}
            steps={groups.research}
            targetOf={targetOf}
            blocked={blocked}
            head={
              <>
                <GroupHead kind="research" about={t('group_research_about')} />
                {!kit && <p className={styles.muted}>{t('group_research_no_kit')}</p>}
                {kit && groups.research.length === 0 && <p className={styles.muted}>{t('group_research_empty')}</p>}
              </>
            }
          />
        </div>
      )}
    </>
  );
}

/** Says why nothing can be built or deployed, and leads to composing the product. */
export function NoProductLine({
  action,
  onIntent,
}: {
  action: PathAction | null | undefined;
  onIntent: (intent: Intent, action: Partial<PathAction>) => void;
}) {
  const { t } = useReleases();
  return (
    <div className={styles.noProduct} role="note" data-releases-no-product>
      <span>{t('no_product_actions')}</span>
      {action && <ActionButton action={action} onIntent={onIntent} />}
    </div>
  );
}
