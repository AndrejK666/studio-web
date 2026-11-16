import React from 'react';
import { Button, Skeleton } from '@gears-frontx/ui-kit';
import { useMfeBridge } from '@gears-frontx/react';
import { GridFailed } from '@constructor-studio/mfe-shared/grid';
import { useProjectListScreenTranslations, useProjectListText } from '../../i18n';
import { WorkspaceProjectsProvider, useWorkspaceProjects } from '../../shared/workspaceProjects';
import { useProjectPhases } from '../../shared/useProjectPhases';
import { openProjectWizard } from '../../actions/wizardActions';
import { SectionHeader } from '../../components/SectionHeader';
import { ProjectsGrid } from './components/ProjectsGrid';
import styles from './ProjectListScreen.module.css';

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-no-workspace:p1
const ProjectList: React.FC = () => {
  const { isLoaded, error: translationsFailed } = useProjectListScreenTranslations();
  const t = useProjectListText();
  const bridge = useMfeBridge();

  const { loading, failed, org, workspace, retry } = useWorkspaceProjects();
  // Project lifecycle's phase per project, where the kit applies.
  const phases = useProjectPhases(org?.id);
  const busy = (!isLoaded && !translationsFailed) || loading;

  const actions = () => (
    <Button
      size="sm"
      disabled={!workspace}
      title={workspace ? undefined : t('empty_no_workspace')}
      onClick={() => openProjectWizard(bridge)}
    >
      {t('new_project')}
    </Button>
  );

  return (
    <div className={styles.screen} data-project-list>
      <SectionHeader title={t('title')} busy={busy} actions={actions()} />

      <section className={styles.body}>
        {busy ? (
          <div className={styles.rowsSkeleton} data-projects-loading>
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
          </div>
        ) : translationsFailed ? (
          <GridFailed message="Could not load this screen." />
        ) : failed ? (
          <GridFailed message={t('error_title')} retry={t('retry')} onRetry={retry} />
        ) : (
          // A new workspace starts the grid clean: its search, sort and page belong to the last one.
          <ProjectsGrid key={workspace?.id ?? 'none'} phases={phases} />
        )}
      </section>
    </div>
  );
};

export const ProjectListScreen: React.FC = () => (
  <WorkspaceProjectsProvider>
    <ProjectList />
  </WorkspaceProjectsProvider>
);

ProjectListScreen.displayName = 'ProjectListScreen';
