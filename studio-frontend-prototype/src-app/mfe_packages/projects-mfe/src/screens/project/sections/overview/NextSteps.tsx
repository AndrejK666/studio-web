/**
 * Project › Overview › Next steps: what the project's type says to do once
 * the project exists (ADR-0073, the type kit's `project_creation.next_steps`
 * as `GET project-creation-types` answers them) -- Gears: connect the
 * repositories, compose the product; Constructor Research: connect a Research
 * project, build and run there. Each row opens the screen where it is done
 * and can be dismissed; a row goes once its path step is done
 * (`model/nextSteps.ts`). A project with no type, or a type with nothing
 * left, shows nothing here.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-type-next:p1
// @cpt-flow:cpt-studiofrontend-flow-project-create-next-steps:p1
import React, { useState } from 'react';
import { apiRegistry, useApiQuery, useQueryCache } from '@gears-frontx/react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@gears-frontx/ui-kit';
import { AccountsApiService, PROJECT_CONFIG_TYPE, errorMessage, type ProjectConfig } from '@constructor-studio/mfe-shared';
import { ProjectStatusApiService } from '../../../../api/ProjectStatusApiService';
import { pendingNextSteps, typeOf, withDismissed } from '../../../../model/nextSteps';
import type { ProjectPathStep } from '../../../../model/projectStatus';
import { projectConfigQuery, useProjectConfig } from '../../../../shared/useProjectConfig';
import type { useOverviewSectionTranslations } from '../../../../i18n';
import styles from './OverviewSection.module.css';

type Text = ReturnType<typeof useOverviewSectionTranslations>['t'];

export const NextSteps: React.FC<{
  projectId: string;
  path: readonly ProjectPathStep[];
  t: Text;
  /** The route if this portal has that screen for the project, else null. */
  reachRoute: (route: string) => string | null;
  open: (route: string | null) => void;
}> = ({ projectId, path, t, reachRoute, open }) => {
  const types = useApiQuery(apiRegistry.getService(ProjectStatusApiService).projectTypeKits, {
    staleTime: Infinity,
  });
  const { config } = useProjectConfig(projectId);
  const cache = useQueryCache();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const type = typeOf(types.data?.items, config?.project_type_kit);
  const pending = pendingNextSteps(type, config?.next_steps_dismissed, path);
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
