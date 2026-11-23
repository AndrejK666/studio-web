/**
 * How far a Research build and its deploy are (#1053): an overall bar by
 * step (prepare, desk, upload, images, deploy, ready), and under it the
 * current step's own bar -- determinate where a total is known ("1,240 /
 * 3,812 files · 46 MB / 120 MB", "1 / 3 images"), moving without a share
 * where it is not (the desk starting). The text log stays under both.
 */

import {
  RESEARCH_STEPS,
  bytesLabel,
  numberLabel,
  overallShare,
  stepShare,
  type ResearchProgress as Progress,
} from '../../model/research-progress';
import { useReleases } from './parts';
import styles from './ReleasesScreen.module.css';

function Bar({ share, label }: { share: number | null; label: string }) {
  const pct = share === null ? null : Math.round(share * 100);
  return (
    <div
      className={styles.progressTrack}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      data-progress-indeterminate={pct === null || undefined}
    >
      <div className={pct === null ? styles.progressIndeterminate : styles.progressFill} style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

/** What the current step counted, as a line: files and bytes, or images. */
function countsLine(p: Progress, t: ReturnType<typeof useReleases>['t'], language: string): string | null {
  const n = (v: number) => numberLabel(v, language);
  if (p.step === 'upload' && p.files) {
    const files = t('progress_files', { done: n(p.files.done), total: n(p.files.total) });
    return p.bytes && p.bytes.total > 0
      ? `${files} · ${bytesLabel(p.bytes.done, language)} / ${bytesLabel(p.bytes.total, language)}`
      : files;
  }
  if (p.step === 'images' && p.images) return t('progress_images', { done: n(p.images.done), total: n(p.images.total) });
  return null;
}

export function ResearchProgress({ progress }: { progress: Progress }) {
  const { t, language } = useReleases();
  const at = RESEARCH_STEPS.indexOf(progress.step);
  const share = stepShare(progress);
  const counts = countsLine(progress, t, language);
  return (
    <div className={styles.progress} data-research-progress={progress.step}>
      <Bar share={overallShare(progress)} label={t('progress_overall')} />
      <ol className={styles.progressSteps} aria-label={t('progress_overall')}>
        {RESEARCH_STEPS.map((s, i) => (
          <li key={s} data-progress-step={s} data-progress-state={i < at ? 'done' : i === at ? 'now' : 'later'}>
            {t(`progress_step_${s}`)}
          </li>
        ))}
      </ol>
      {progress.step !== 'ready' && (
        <div className={styles.progressStep} data-progress-current>
          <Bar share={share} label={t(`progress_step_${progress.step}`)} />
          <span className={styles.muted} data-progress-counts>
            {counts ?? t(share === null ? 'progress_waiting' : 'progress_working')}
          </span>
        </div>
      )}
    </div>
  );
}
