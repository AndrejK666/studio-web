/**
 * Project › Overview › Next steps: what the project's type says to do once
 * the project exists (ADR-0073, the type kit's `project_creation.next_steps`
 * as `GET project-creation-types` answers them) -- Gears: connect the
 * repositories, compose the product; Constructor Research: connect a Research
 * project, build and run there. Each row opens the screen where it is done
 * and can be dismissed; a row goes once its path step is done, or once the
 * project field it waits on is set (`done_when = "field:<name>"`, read from
 * the project's object in the domain model only while such a row is pending;
 * a failed read leaves it pending) (`model/nextSteps.ts`). A project with no
 * type, or a type with nothing left, shows nothing here.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-type-next:p1
// @cpt-flow:cpt-studiofrontend-flow-project-create-next-steps:p1
import React, { useEffect, useState } from 'react';
import { apiRegistry, useApiQuery, useQueryCache } from '@gears-frontx/react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@gears-frontx/ui-kit';
import {
  AccountsApiService,
  DomainModelApiService,
  PROJECT_CONFIG_TYPE,
  errorMessage,
  useOrganization,
  type ProjectConfig,
} from '@constructor-studio/mfe-shared';
import { ProjectStatusApiService } from '../../../../api/ProjectStatusApiService';
import { PROJECT_OBJECT_TYPE, fieldsAwaited, pendingNextSteps, typeOf, withDismissed } from '../../../../model/nextSteps';
import type { ProjectPathStep } from '../../../../model/projectStatus';
import { projectConfigQuery, useProjectConfig } from '../../../../shared/useProjectConfig';
import type { useOverviewSectionTranslations } from '../../../../i18n';
import styles from './OverviewSection.module.css';

type Text = ReturnType<typeof useOverviewSectionTranslations>['t'];

/** The project fields read, and for which names: a read for other names is not theirs. */
interface FieldsRead {
  names: string;
  values: Record<string, unknown>;
}

/**
 * The values of `names` (comma-joined, sorted) on the project's object in the
 * organization's domain model; `undefined` until read, when none is asked,
 * or when the read failed — the steps waiting on them then stay pending.
 */
function useProjectFields(
  orgId: string | null,
  projectId: string,
  names: string
): Readonly<Record<string, unknown>> | undefined {
  const [read, setRead] = useState<FieldsRead | null>(null);
  useEffect(() => {
    if (!orgId || !names) return undefined;
    let live = true;
    apiRegistry
      .getService(DomainModelApiService)
      .query(orgId)
      .fetch({
        type: PROJECT_OBJECT_TYPE,
        project_id: projectId,
        where: { tenant_id: { _eq: projectId } },
        fields: names.split(','),
        limit: 1,
      })
      .then(
        (res) => {
          if (live) setRead({ names, values: res.items[0]?.value ?? {} });
        },
        () => {
          if (live) setRead(null);
        }
      );
    return () => {
      live = false;
    };
  }, [orgId, projectId, names]);
  return read && read.names === names ? read.values : undefined;
}

export const NextSteps: React.FC<{
  projectId: string;
  /** The organization on screen: whose domain model a `field:` step is read from. */
  orgId?: string | null;
  path: readonly ProjectPathStep[];
  t: Text;
  /** The route if this portal has that screen for the project, else null. */
  reachRoute: (route: string) => string | null;
  open: (route: string | null) => void;
}> = ({ projectId, orgId = null, path, t, reachRoute, open }) => {
  const { org } = useOrganization();
  const types = useApiQuery(
    apiRegistry.getService(ProjectStatusApiService).projectTypeKits({ organizationId: orgId ?? org?.id ?? null }),
    { staleTime: Infinity }
  );
  const { config } = useProjectConfig(projectId);
  const cache = useQueryCache();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const type = typeOf(types.data?.items, config?.project_type_kit);
  // Read only while a step not dismissed waits on a project field.
  const fields = useProjectFields(orgId, projectId, fieldsAwaited(type, config?.next_steps_dismissed).join(','));
  const pending = pendingNextSteps(type, config?.next_steps_dismissed, path, fields);
  if (!type || pending.length === 0) return null;

  // The config is one value written whole: read fresh, add the id, write
  // everything else back as it was.
  const dismiss = async (id: string) => {
    setBusy(id);
    setFailed(null);
    try {
      const accounts = apiRegistry.getService(AccountsApiService);
      const read = projectConfigQuery(accounts, projectId);
      const fresh: ProjectConfig = (await read.fetch({ staleTime: 0 }))?.value ?? {};
      await accounts
        .putTenantMetadata<ProjectConfig>(projectId, PROJECT_CONFIG_TYPE)
        .fetch({ ...fresh, next_steps_dismissed: withDismissed(fresh.next_steps_dismissed, id) });
      void cache.invalidate(read);
    } catch (error) {
      setFailed(t('next_dismiss_failed', { error: errorMessage(error) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card data-next-steps={type.slug}>
      <CardHeader>
        <CardTitle className={styles.cardTitle}>
          {t('next_title', { type: type.name })}
          <span className={styles.count}>{pending.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className={styles.list}>
          {pending.map((step) => {
            const route = reachRoute(step.route);
            return (
              <li key={step.id} className={`${styles.row} ${styles.info}`} data-next-step-row={step.id}>
                <span className={styles.rowText}>
                  <b>{step.label}</b>
                  {step.description && <span className={styles.muted}>{step.description}</span>}
                </span>
                {route && (
                  <Button variant="outline" size="sm" onClick={() => open(route)}>
                    {t('next_open')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  data-next-dismiss={step.id}
                  onClick={() => void dismiss(step.id)}
                >
                  {t('next_dismiss')}
                </Button>
              </li>
            );
          })}
        </ul>
        {failed && (
          <p role="alert" className={styles.error}>
            {failed}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

NextSteps.displayName = 'NextSteps';
