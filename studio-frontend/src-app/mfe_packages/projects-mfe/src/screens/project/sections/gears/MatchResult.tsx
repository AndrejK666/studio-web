import React from 'react';
import type { Coverage, RequirementCoverage } from '../../../../api/gearsMatcherClient';
import { useGearsText } from '../../../../i18n';
import type { GearsRun } from '../../../../slices/gearsMatchSlice';
import styles from './GearsSection.module.css';

const ORDER: readonly Coverage[] = [
  'covered',
  'partial',
  'gap',
  'clarification_needed',
  'not_assessed',
];

/** How many requirements fall under each kind of coverage. */
export function countCoverage(
  requirements: readonly RequirementCoverage[]
): Record<Coverage, number> {
  const counts: Record<Coverage, number> = {
    covered: 0,
    partial: 0,
    gap: 0,
    clarification_needed: 0,
    not_assessed: 0,
  };
  for (const requirement of requirements) counts[requirement.coverage] += 1;
  return counts;
}

interface MatchResultProps {
  run: GearsRun;
  providerName: string;
}

/** A match as it goes and as it ends: its progress, its failure, or its report. */
export const MatchResult: React.FC<MatchResultProps> = ({ run, providerName }) => {
  const t = useGearsText();
  const names = { spec: run.spec, provider: providerName, models: run.models };

  if (run.phase === 'running') {
    return (
      <div className={styles.panel} role="status">
        <p className={styles.muted}>{t('running_note', names)}</p>
        <p className={styles.muted}>
          {run.total > 0
            ? t('running_progress', {
                done: run.done,
                total: run.total,
                calls: run.calls,
              })
            : t('running_start')}
        </p>
      </div>
    );
  }

  if (run.phase === 'failed') {
    return (
      <div className={styles.panel} role="alert">
        <p className={styles.error}>{t('failed_title')}</p>
        <p className={styles.muted}>{run.error}</p>
      </div>
    );
  }

  const report = run.report;
  if (!report) return null;
  const counts = countCoverage(report.requirements);

  return (
    <div className={styles.panel}>
      <p className={styles.muted}>{t('summary', { ...names, calls: run.calls })}</p>
      <ul className={styles.totals}>
        {ORDER.filter((kind) => counts[kind] > 0 || kind === 'covered').map((kind) => (
          <li key={kind} className={styles.total}>
            <span className={styles.totalCount}>{counts[kind]}</span>
            <span className={styles.muted}>{t(`totals_${kind}`)}</span>
          </li>
        ))}
      </ul>
      {run.state === 'partial' && <p className={styles.muted}>{t('partial_note')}</p>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('col_requirement')}</th>
              <th scope="col">{t('col_coverage')}</th>
              <th scope="col">{t('col_gears')}</th>
            </tr>
          </thead>
          <tbody>
            {report.requirements.map((requirement) => (
              <tr key={requirement.requirement_id}>
                <td className={styles.mono}>{requirement.requirement_id}</td>
                <td
                  className={`${styles.coverage} ${styles[requirement.coverage]}`}
                  title={requirement.reason ?? undefined}
                >
                  {t(`coverage_${requirement.coverage}`)}
                </td>
                <td className={styles.mono}>
                  {requirement.gears.length > 0
                    ? requirement.gears.map((gear) => gear.gear_id).join(', ')
                    : t('no_gears')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.recommended_gears.length > 0 && (
        <>
          <h3 className={styles.heading}>{t('recommended')}</h3>
          <ul className={styles.gearList}>
            {report.recommended_gears.map((gear) => (
              <li key={gear.gear_id}>
                <span className={styles.mono}>{gear.name ?? gear.gear_id}</span>{' '}
                <span className={styles.muted}>
                  {gear.requirement_ids.length === 1
                    ? t('recommended_for_one')
                    : t('recommended_for', {
                        count: gear.requirement_ids.length,
                      })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

MatchResult.displayName = 'MatchResult';
