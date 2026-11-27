import { AccountsApiService, type ProjectSource } from '@constructor-studio/mfe-shared';
import React, { useEffect, useState } from 'react';
import {
  apiRegistry,
  useApiQuery,
  useAppDispatch,
  useAppSelector,
  useMfeBridge,
} from '@gears-frontx/react';
import { Button, Card, CardContent, Input } from '@gears-frontx/ui-kit';
import { PageLoading, ProjectPage } from '@constructor-studio/mfe-shared/page';
import { useOrganization, useWorkspace } from '@constructor-studio/mfe-shared';
import { useProjectScreenTranslations, useProjectText } from '../../i18n';
import { useArtifactCount } from '../../shared/useArtifacts';
import { useArtifactImport } from '../../shared/useArtifactImport';
import { useSourcesSync } from '../../shared/useSourcesSync';
import { NAV_SLICE_KEY, landOnFirstImport, type ProjectSection } from '../../slices/navSlice';
import { announceSection } from '../../actions/projectsActions';
import { PlaceholderSection } from './sections/PlaceholderSection';
import { ArtifactsSection } from './sections/ArtifactsSection';
import { OverviewSection } from './sections/overview/OverviewSection';
import { SpecsSection } from './sections/specs/SpecsSection';
import { SourcesSection } from './sections/sources/SourcesSection';
import { SourcesActions } from './sections/sources/SourcesActions';
import { SpecsActions } from './sections/specs/SpecsActions';
import { UploadDocumentsButton } from './upload/UploadDocumentsButton';
import styles from './ProjectScreen.module.css';

/** A section's buttons in the project header, given the open project. */
const SECTION_ACTIONS: Partial<
  Record<ProjectSection, React.FC<{ projectId: string; projectName: string }>>
> = {
  artifacts: UploadDocumentsButton,
  specs: SpecsActions,
  sources: SourcesActions,
};

interface ImportWatchProps {
  projectId: string;
  orgId: string;
  workspaceId: string | null;
  artifactCount: number;
  sources: readonly ProjectSource[];
  artifactsRead: boolean;
}
const ImportWatch: React.FC<ImportWatchProps> = ({
  projectId,
  orgId,
  workspaceId,
  artifactCount,
  sources,
  artifactsRead,
}) => {
  const dispatch = useAppDispatch();
  const bridge = useMfeBridge();
  const { isFirstImport, start } = useArtifactImport({
    projectId,
    workspaceId,
    orgId,
    sources,
    artifactCount,
    artifactsRead,
  });
  useSourcesSync({
    projectId,
    workspaceId,
    orgId,
    sources,
    sourcesRead: artifactsRead,
    isFirstImport,
  });

  useEffect(() => {
    if (!isFirstImport) return;
    dispatch(landOnFirstImport());
    announceSection(bridge, 'artifacts');
    start();
  }, [isFirstImport, dispatch, start, bridge]);

  return null;
};

ImportWatch.displayName = 'ImportWatch';

interface ProjectScreenProps {
  projectId: string;
}

export const ProjectScreen: React.FC<ProjectScreenProps> = ({ projectId }) => {
  const { isLoaded, error: translationsFailed } = useProjectScreenTranslations();
  const t = useProjectText();
  const accounts = apiRegistry.getService(AccountsApiService);
  const {
    data: project,
    refetch: refreshProject,
    isLoading,
    isError,
  } = useApiQuery(accounts.getTenant({ tenantId: projectId }));
  const section = useAppSelector((state) => state[NAV_SLICE_KEY].section);

  const { org } = useOrganization();
  const { workspace } = useWorkspace();
  const {
    total: artifactCount,
    sources,
    loading: artifactsLoading,
    failed: artifactsFailed,
  } = useArtifactCount(projectId);
  const artifactsRead = !artifactsLoading && !artifactsFailed;

  const busy = (!isLoaded && !translationsFailed) || isLoading;
  const Actions = SECTION_ACTIONS[section];

  const actions = () => {
    if (busy || !project || !Actions) return null;
    return <Actions projectId={projectId} projectName={project.name} />;
  };

  const body = () => {
    if (busy) return <PageLoading label={t('loading')} />;
    if (isError || !project) {
      return <PlaceholderSection title={t('error_title')} note={t('error_hint')} />;
    }

    switch (section) {
      case 'overview':
        return <OverviewSection projectId={projectId} orgId={org?.id ?? null} />;
      case 'artifacts':
        return <ArtifactsSection projectId={projectId} projectName={project.name} />;
      case 'specs':
        return <SpecsSection projectId={projectId} projectName={project.name} />;
      case 'sources':
        return <SourcesSection projectId={projectId} projectName={project.name} />;
      case 'settings':
        return <ProjectSettings key={projectId} name={project.name} rename={async (name) => {
          await accounts.renameTenant(projectId).fetch({ name });
          await refreshProject();
        }} />;
      default:
        return <PlaceholderSection title={t(`section_${section}`)} note={t('no_source_yet')} />;
    }
  };

  const help = section === 'overview' ? t('help_overview') : undefined;

  return (
    <ProjectPage
      title={t(`section_${section}`)}
      busy={busy}
      help={help}
      helpLabel={t('help_label')}
      actions={actions()}
      section={section}
    >
      {org && (
        <ImportWatch
          projectId={projectId}
          orgId={org.id}
          workspaceId={workspace?.id ?? null}
          artifactCount={artifactCount}
          sources={sources}
          artifactsRead={artifactsRead}
        />
      )}
      {body()}
    </ProjectPage>
  );
};

ProjectScreen.displayName = 'ProjectScreen';

function ProjectSettings({ name, rename }: { name: string; rename: (name: string) => Promise<void> }) {
  const t = useProjectText();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = (draft ?? name).trim();

  return (
    <Card>
      <CardContent>
        <form className={styles.sectionBody} onSubmit={async (event) => {
          event.preventDefault();
          if (saving || !next || next === name) return;
          setSaving(true);
          setError(null);
          setSaved(false);
          try {
            await rename(next);
            setDraft(null);
            setSaved(true);
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            setSaving(false);
          }
        }}>
          <label className={styles.sectionBody}>
            {t('field_name')}
            <Input value={draft ?? name} required disabled={saving} onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }} />
          </label>
          <div>
            <Button type="submit" disabled={saving || !next || next === name}>
              {t(saving ? 'settings_saving' : 'settings_save')}
            </Button>
          </div>
          {saved && <p role="status">{t('settings_saved')}</p>}
          {error && <p role="alert" className={styles.repoFailure}>{t('settings_save_failed', { reason: error })}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
