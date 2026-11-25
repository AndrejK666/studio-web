/**
 * Specs › Automatic pipeline: after every repository sync the project's specs
 * go on by themselves — proposed types at or over the threshold are confirmed
 * automatically, the project domain model is built on the organization's AI
 * connection, what the documents need is recorded for the gear plan, and a
 * gear match proposes the product (`GET /studio-documents/v1/spec-pipeline`).
 *
 * Shows each step as it last went, with the reason when it waits or stopped,
 * and the project's two settings: the switch and the threshold. Read again
 * when a background run ends (a sync, the pipeline itself).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Button, Checkbox, Input } from '@gears-frontx/ui-kit';
import { errorMessage, isRunEnding, useStudioEventRefresh } from '@constructor-studio/mfe-shared';
import { DocumentsApiService } from '../../../../api/DocumentsApiService';
import type { SpecPipelineDto, SpecPipelineSettingsRequest } from '../../../../api/documentTypes';
import type { BadgeVariant } from '../../../../model/projectStatus';
import { useSpecsText } from '../../../../i18n';
import styles from './SpecPipeline.module.css';

const STEPS = ['specs', 'domain_model', 'mapping', 'product'] as const;

/** How a step's state reads as a badge. */
export const STATE_VARIANT: Record<string, BadgeVariant> = {
  done: 'success',
  unchanged: 'success',
  running: 'info',
  waiting: 'secondary',
  stopped: 'danger',
  off: 'secondary',
};

/** The threshold as a whole percent, for the input. */
export function percentOf(threshold: number): number {
  return Math.round(threshold * 100);
}

/** A typed percent as a threshold, or null when it is not one (0..100). */
export function thresholdOf(text: string): number | null {
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value / 100;
}

export const SpecPipeline: React.FC<{ projectId: string }> = ({ projectId }) => {
  const t = useSpecsText();
  const [pipeline, setPipeline] = useState<SpecPipelineDto | null>(null);
  /** What went wrong last: the read, or a change (with the server's words). */
  const [failure, setFailure] = useState<{ save: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState('');

  const load = useCallback(() => {
    const documents = apiRegistry.getService(DocumentsApiService);
    return documents
      .specPipeline({ projectId })
      .fetch({ staleTime: 0 })
      .then(
        (p) => {
          setPipeline(p);
          setThreshold(String(percentOf(p.auto_confirm_threshold)));
          setFailure(null);
        },
        () => setFailure({ save: null })
      );
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);
  useStudioEventRefresh(isRunEnding, () => void load());

  const save = (change: Omit<SpecPipelineSettingsRequest, 'project_id'>) => {
    setBusy(true);
    apiRegistry
      .getService(DocumentsApiService)
      .putSpecPipelineSettings()
      .fetch({ project_id: projectId, ...change })
      .then(
        (p) => {
          setPipeline(p);
          setThreshold(String(percentOf(p.auto_confirm_threshold)));
          setFailure(null);
        },
        (error: unknown) => setFailure({ save: errorMessage(error) })
      )
      .finally(() => setBusy(false));
  };

  const run = () => {
    setBusy(true);
    apiRegistry
      .getService(DocumentsApiService)
      .runSpecPipeline()
      .fetch({ project_id: projectId })
      .then(
        () => load(),
        (error: unknown) => setFailure({ save: errorMessage(error) })
      )
      .finally(() => setBusy(false));
  };

  const failed =
    failure === null
      ? null
      : failure.save === null
        ? t('pipeline_failed')
        : t('pipeline_save_failed', { error: failure.save });

  if (!pipeline) {
    return failed ? (
      <p className={styles.error} role="alert" data-spec-pipeline-error="">
        {failed}
      </p>
    ) : null;
  }

  const commitThreshold = () => {
    const value = thresholdOf(threshold);
    if (value === null) {
      setThreshold(String(percentOf(pipeline.auto_confirm_threshold)));
      return;
    }
    if (value !== pipeline.auto_confirm_threshold) save({ auto_confirm_threshold: value });
  };
  const steps = STEPS.map((id) => pipeline.steps.find((s) => s.step === id) ?? null);

  return (
    <section className={styles.pipeline} data-spec-pipeline="" aria-label={t('pipeline_title')}>
      <div className={styles.head}>
        <span className={styles.title}>{t('pipeline_title')}</span>
        <div className={styles.controls}>
          <label className={styles.control}>
            <Checkbox
              checked={pipeline.enabled}
              disabled={busy}
              onCheckedChange={(v) => save({ enabled: v === true })}
              data-spec-pipeline-enabled=""
            />
            {t('pipeline_on')}
          </label>
          <label className={styles.control} title={t('pipeline_threshold_title')}>
            {t('pipeline_threshold')}
            <Input
              className={styles.threshold}
              type="number"
              min={0}
              max={100}
              step={5}
              value={threshold}
              disabled={busy || !pipeline.enabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setThreshold(e.target.value)}
              onBlur={commitThreshold}
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') commitThreshold();
              }}
              data-spec-pipeline-threshold=""
            />
            %
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !pipeline.enabled}
            onClick={run}
            data-spec-pipeline-run=""
          >
            {t('pipeline_run')}
          </Button>
        </div>
      </div>
      {pipeline.steps.length === 0 ? (
        <span className={styles.muted}>{t('pipeline_never')}</span>
      ) : (
        <ul className={styles.steps}>
          {STEPS.map((id, i) => {
            const step = steps[i];
            return (
              <li key={id} className={styles.step} data-spec-pipeline-step={id} data-state={step?.state ?? ''}>
                <span className={styles.stepHead}>
                  <b>{t(`step_${id}`)}</b>
                  {step && (
                    <Badge variant={STATE_VARIANT[step.state] ?? 'secondary'}>{t(`state_${step.state}`)}</Badge>
                  )}
                </span>
                {step?.summary && <span className={styles.muted}>{step.summary}</span>}
                {step?.reason && (
                  <span className={step.state === 'stopped' ? styles.error : styles.muted} data-step-reason="">
                    {step.reason}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {failed && (
        <span className={styles.error} role="alert">
          {failed}
        </span>
      )}
    </section>
  );
};

SpecPipeline.displayName = 'SpecPipeline';
