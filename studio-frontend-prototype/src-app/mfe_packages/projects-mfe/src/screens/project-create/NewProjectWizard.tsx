/**
 * The New project wizard — this MFE's second mounted root, drawn inside the
 * shell's overlay frame. It asks for a name, the project type, a goal and
 * shows the owner; the type decides what the creation does and what the
 * project's Overview offers next (ADR-0073).
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-steps:p1
import React, { useEffect } from 'react';
import { apiRegistry, eventBus, useApiQuery, useMfeBridge } from '@gears-frontx/react';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import { Button, Skeleton } from '@gears-frontx/ui-kit';
import {
  OrganizationProvider,
  WorkspaceProvider,
  isNotFound,
  useEverLoaded,
  useHostChrome,
  useOrganization,
  useWorkspace,
} from '@constructor-studio/mfe-shared';
import { useProjectCreateScreenTranslations, useProjectCreateText } from '../../i18n';
import { closeProjectWizard, requestProjectCreate } from '../../actions/wizardActions';
import { announceCreatedProject } from '../../actions/projectsActions';
import '../../events/wizardEvents';
import { CREATE_SLICE_KEY, editDraft, goToStep, resetWizard } from '../../slices/createSlice';
import { useCurrentUser } from '../../shared/useCurrentUser';
import { isFinalStep, nextStep, prevStep, stepFor, type WizardStepKey } from '../../model/wizardSteps';
import { DetailsStep } from './steps/DetailsStep';
import { ProjectStatusApiService, type ProjectTypeKit } from '../../api/ProjectStatusApiService';
import frame from '../../components/OverlayFrame.module.css';
import styles from './NewProjectWizard.module.css';

/** One entry per step key. Adding a step touches this map and `WIZARD_STEPS`. */
const STEP_BODIES: Record<WizardStepKey, React.FC<{ projectTypes: readonly ProjectTypeKit[] }>> = {
  details: DetailsStep,
};

const WizardBody: React.FC = () => {
  const bridge = useMfeBridge();
  const { containerRef, dataTheme } = useHostChrome();
  const { isLoaded, error: translationsFailed } = useProjectCreateScreenTranslations();
  const t = useProjectCreateText();
  const dispatch = useAppDispatch();

  const stepKey = useAppSelector((state) => state[CREATE_SLICE_KEY].stepKey);
  const draft = useAppSelector((state) => state[CREATE_SLICE_KEY].draft);
  const submitting = useAppSelector((state) => state[CREATE_SLICE_KEY].submitting);
  const error = useAppSelector((state) => state[CREATE_SLICE_KEY].error);
  const progress = useAppSelector((state) => state[CREATE_SLICE_KEY].progress);
  const { loading: orgLoading } = useOrganization();
  const { workspace, loading: workspaceLoading } = useWorkspace();
  const workspaceId = workspace?.id ?? null;
  const types = useApiQuery(apiRegistry.getService(ProjectStatusApiService).projectTypeKits);
  const projectTypes = types.data?.items ?? [];
  const typeReadFailed = types.isError && !isNotFound(types.error);
  const typeMissing = projectTypes.length > 0 && !projectTypes.some((kit) => kit.slug === draft.typeKit);

  useEffect(() => {
    dispatch(resetWizard());
  }, [dispatch]);

  const { id: currentUserId } = useCurrentUser();
  useEffect(() => {
    if (currentUserId && !draft.ownerId) dispatch(editDraft({ ownerId: currentUserId }));
  }, [currentUserId, draft.ownerId, dispatch]);


  /**
   * The skeleton is for the first load and nothing else.
   */
  const showSkeleton = !useEverLoaded(isLoaded) && !translationsFailed;

  const step = stepFor(draft, stepKey);
  const back = prevStep(draft, step.key);
  const final = isFinalStep(draft, step.key);
  const Body = STEP_BODIES[step.key];

  useEffect(() => {
    const subscription = eventBus.on(
      'mfe/projects/created',
      ({ project, siblings, workspaceId: writtenUnder }) => {
        announceCreatedProject(bridge, project, siblings, writtenUnder);
        closeProjectWizard(bridge);
      }
    );
    return () => subscription.unsubscribe();
  }, [bridge]);

  const onPrimary = (): void => {
    if (final) {
      if (!workspaceId) return;
      requestProjectCreate(workspaceId, draft);
      return;
    }
    const next = nextStep(draft, step.key);
    if (next) dispatch(goToStep(next.key));
  };

  const onSecondary = (): void => {
    if (back) dispatch(goToStep(back.key));
    else closeProjectWizard(bridge);
  };

  return (
    <div ref={containerRef} className={frame.card} data-theme={dataTheme} data-step={step.key}>
      {showSkeleton ? (
        <Skeleton className={frame.titleSkeleton} />
      ) : (
        <h2 className={frame.title}>{t(step.titleKey)}</h2>
      )}

      <div className={frame.body}>
        {showSkeleton ? (
          <Skeleton className={frame.bodySkeleton} />
        ) : progress ? (
          // The server's run, step by step: the dialog follows it until it ends.
          <section aria-live="polite" className={styles.progress} data-create-run={progress.state}>
            <h3 className={styles.progressTitle}>{t('progress_title')}</h3>
            <ol className={styles.progressSteps}>
              {progress.steps.map((s) => (
                <li key={s.key} data-create-step={s.key} data-state={s.state} title={s.detail ?? undefined}>
                  <span>{t(`step_${s.key}`)}</span>
                  <span className={styles.progressState}>{t(`step_${s.state}`)}</span>
                </li>
              ))}
            </ol>
            {!submitting && progress.state !== 'succeeded' && <p className={styles.progressHint}>{t('retry_hint')}</p>}
          </section>
        ) : (
          <Body projectTypes={projectTypes} />
        )}
      </div>

      {(translationsFailed || error || (final && !workspaceId && !workspaceLoading)) && (
        <p className={frame.error} role="alert">
          {translationsFailed
            ? 'Could not load this screen.'
            : error
              ? error.kind === 'i18n'
                ? t(error.key)
                : error.text
              : t('error_no_workspace')}
        </p>
      )}
      {types.isLoading && <p role="status">{t('project_types_loading')}</p>}
      {typeReadFailed && <p className={frame.error} role="alert">
        {t('project_types_error')}{' '}
        <Button type="button" variant="ghost" size="sm" onClick={() => void types.refetch()}>{t('project_types_retry')}</Button>
      </p>}

      <div className={frame.footer}>
        <div className={frame.footerNote} />
        <Button variant="ghost" size="sm" onClick={onSecondary} disabled={submitting}>
          {back ? t('back') : t('cancel')}
        </Button>
        <Button
          size="sm"
          onClick={onPrimary}
          disabled={
            submitting ||
            orgLoading ||
            workspaceLoading ||
            types.isLoading ||
            typeReadFailed ||
            typeMissing ||
            !step.isComplete(draft) ||
            (final && !workspaceId)
          }
        >
          {final ? t('create') : t('continue')}
        </Button>
      </div>
    </div>
  );
};

WizardBody.displayName = 'WizardBody';

export const NewProjectWizard: React.FC = () => (
  <OrganizationProvider>
    <WorkspaceProvider>
      <WizardBody />
    </WorkspaceProvider>
  </OrganizationProvider>
);

NewProjectWizard.displayName = 'NewProjectWizard';
